import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { runtimeRoot } from "../config.js";
import { NativeBrowserSession, type AuthRefreshResult } from "./browser-session.js";
import { normalizeGeminiRequest, type NormalizedGeminiRequest } from "./gemini-normalize.js";
import { parseAIStudioResponse, toGeminiResponse, type ParsedAIStudioResponse } from "./response-parser.js";
import { encodeCountTokensBody, rewriteWireBody } from "./wire-codec.js";
import type { AistudioContent, AistudioPart } from "./wire-codec.js";
import { fetchCountTokens, fetchModelCatalog } from "./model-catalog.js";
import { validateGenerationConfig } from "./generation-limits.js";
import { IncrementalAIStudioParser } from "./incremental-parser.js";
import { assertProtocolCapability } from "./protocol-capabilities.js";
import type { AccountProfile } from "../accounts/account-profile.js";

export interface NativeGenerationOptions {
  readonly previousResponseId?: string | null;
  readonly onResponseId?: (responseId: string) => void;
}

interface ToolGroups {
  readonly builtins: unknown[][];
  readonly functions: unknown[][];
}

function isFunctionTool(tool: unknown[]): boolean {
  return Array.isArray(tool[1]) && tool[1].length > 0;
}

export function partitionMixedTools(tools: unknown[][] | null): ToolGroups {
  const builtins: unknown[][] = [];
  const functions: unknown[][] = [];
  for (const tool of tools ?? []) (isFunctionTool(tool) ? functions : builtins).push(tool);
  return { builtins, functions };
}

function bridgeBuiltinResult(contents: readonly AistudioContent[], parsed: ParsedAIStudioResponse): AistudioContent[] {
  const parts: AistudioPart[] = [];
  for (const part of parsed.candidate.parts) {
    if (typeof part.text === "string") {
      parts.push({ text: part.text, ...(part.thought === true ? { thought: true } : {}) });
      continue;
    }
    if (part.inlineData && typeof part.inlineData === "object") {
      const value = part.inlineData as { mimeType?: unknown; data?: unknown };
      if (typeof value.mimeType === "string" && typeof value.data === "string") parts.push({ inlineData: [value.mimeType, value.data] });
    }
  }
  return [
    ...contents,
    { role: "model", parts: parts.length > 0 ? parts : [{ text: parsed.candidate.text }] },
    { role: "user", parts: [{ text: "Continue the original request using the built-in tool result above. Call an available custom function when the original request requires it." }] },
  ];
}

function emptyCandidateResponse(parsed: ParsedAIStudioResponse): boolean {
  const { candidate } = parsed;
  return !candidate.text.trim()
    && !candidate.thinking.trim()
    && !candidate.parts.some(part => "functionCall" in part || "inlineData" in part)
    // A successful safety/terminal response can legitimately contain no parts.
    && candidate.finishReason === undefined;
}

function hasFunctionResponse(contents: readonly AistudioContent[]): boolean {
  return contents.some(content => content.parts.some(part => Boolean(part.functionResponse)));
}

export class NativeGateway {
  private modelCache: { readonly expires: number; readonly models: Record<string, unknown>[] } | undefined;
  constructor(private readonly session = new NativeBrowserSession()) {}

  async warmup(): Promise<void> {
    await this.session.warmup();
  }

  async refreshAuth(): Promise<AuthRefreshResult> {
    const result = await this.session.refreshAuth();
    if (result.status === "refreshed" || result.status === "still_healthy") this.modelCache = undefined;
    return result;
  }

  async switchAuth(authFile: string): Promise<void> {
    await this.session.switchAuth(authFile);
    this.modelCache = undefined;
  }

  async models(): Promise<Record<string, unknown>[]> {
    if (this.modelCache && this.modelCache.expires > Date.now()) return structuredClone(this.modelCache.models);
    const models = await fetchModelCatalog(this.session);
    this.modelCache = { models: structuredClone(models), expires: Date.now() + 60 * 60 * 1000 };
    return models;
  }

  /** 基于 ListModels 目录校验 generation 参数；目录不可用时 fail-open 不阻塞请求。 */
  private async validateGeneration(normalized: NormalizedGeminiRequest): Promise<void> {
    let models: Record<string, unknown>[];
    try {
      models = await this.models();
    } catch {
      return;
    }
    const entry = models.find(item => item.name === normalized.model);
    validateGenerationConfig(entry, normalized.generationConfig);
  }

  async countTokens(model: string, body: unknown): Promise<Record<string, unknown>> {
    assertProtocolCapability("countTokens");
    const normalized = normalizeGeminiRequest(model, body);
    const wire = encodeCountTokensBody({
      model: normalized.model,
      contents: normalized.contents,
      systemInstruction: normalized.systemInstruction,
      tools: normalized.tools,
    });
    const totalTokens = await fetchCountTokens(this.session, wire);
    return { totalTokens };
  }

  async generate(
    model: string,
    body: unknown,
    signal?: AbortSignal,
    options?: NativeGenerationOptions,
  ): Promise<Record<string, unknown>> {
    return this.generateInternal(model, body, undefined, signal, options);
  }

  async generateStream(
    model: string,
    body: unknown,
    onResponse: (response: Record<string, unknown>) => void,
    signal?: AbortSignal,
    options?: NativeGenerationOptions,
  ): Promise<Record<string, unknown>> {
    return this.generateInternal(model, body, onResponse, signal, options);
  }

  private async generateInternal(
    model: string,
    body: unknown,
    onResponse?: (response: Record<string, unknown>) => void,
    signal?: AbortSignal,
    options?: NativeGenerationOptions,
  ): Promise<Record<string, unknown>> {
    assertProtocolCapability("generateContent");
    const normalized = normalizeGeminiRequest(model, body);
    await this.validateGeneration(normalized);
    const template = await this.session.captureTemplate(normalized.model);
    const generation = normalized.generationConfig;
    const makeBody = async (
      contents: readonly AistudioContent[],
      tools: unknown[][] | null,
      sanitizePlainText: boolean,
      disableThinking = false,
    ): Promise<string> => {
      const snapshot = await this.session.generateSnapshot(contents);
      const wireBody = rewriteWireBody(template.body, {
        model: normalized.model,
        contents,
        snapshot,
        systemInstruction: normalized.systemInstruction,
        tools,
        safetySettings: normalized.safetySettings,
        generationConfig: generation,
        ...(typeof generation.temperature === "number" ? { temperature: generation.temperature } : {}),
        ...(typeof generation.topP === "number" ? { topP: generation.topP } : {}),
        ...(typeof generation.topK === "number" ? { topK: generation.topK } : {}),
        ...(typeof generation.maxOutputTokens === "number" ? { maxTokens: generation.maxOutputTokens } : {}),
        sanitizePlainText,
        ...(template.timezone ? { timezone: template.timezone } : {}),
        disableThinking: disableThinking || normalized.model.toLowerCase().includes("gemini-2.5-flash-image"),
        ...(sanitizePlainText
          ? { previousResponseId: null }
          : options?.previousResponseId !== undefined ? { previousResponseId: options.previousResponseId } : {}),
      });
      if (process.env.AISTUDIO_DEBUG_WIRE === "1") {
        try {
          appendFileSync(join(runtimeRoot, "data", "wire-debug.log"), JSON.stringify({ time: new Date().toISOString(), sanitizePlainText, body: JSON.parse(wireBody) }) + "\n");
        } catch { /* debug only */ }
      }
      return wireBody;
    };
    // 记录最近一次 wire 请求体，用于上游返回非 2xx 时落盘诊断（wire-debug.log）。
    let lastWireBody = "";
    const makeLoggedBody = async (contents: readonly AistudioContent[], tools: unknown[][] | null, sanitizePlainText: boolean, disableThinking = false): Promise<string> => {
      lastWireBody = await makeBody(contents, tools, sanitizePlainText, disableThinking);
      return lastWireBody;
    };
    const replay = async (wireBody: string): Promise<{ status: number; body: string }> => {
      if (!onResponse) return this.session.replay(wireBody, undefined, signal);
      const parser = new IncrementalAIStudioParser();
      return this.session.replayStream(wireBody, raw => {
        for (const chunk of parser.feed(raw)) {
          const parsed = parseAIStudioResponse(JSON.stringify(chunk));
          const candidate = parsed.candidate;
          if (candidate.text || candidate.thinking || candidate.parts.some(part => "functionCall" in part || "inlineData" in part)) {
            onResponse(toGeminiResponse(parsed));
          }
        }
      }, signal);
    };
    const toolGroups = partitionMixedTools(normalized.tools);
    const emulateMixedTools = normalized.includeServerSideToolInvocations
      && toolGroups.builtins.length > 0
      && toolGroups.functions.length > 0;
    const effectiveTools = emulateMixedTools ? toolGroups.functions : normalized.tools;
    let response: { status: number; body: string };
    if (emulateMixedTools && !hasFunctionResponse(normalized.contents)) {
      const builtinResponse = await this.session.replay(await makeLoggedBody(normalized.contents, toolGroups.builtins, false), undefined, signal);
      if (builtinResponse.status < 200 || builtinResponse.status >= 300) {
        throw Object.assign(
          new Error(`AI Studio built-in tool phase returned HTTP ${builtinResponse.status}: ${builtinResponse.body.slice(0, 500)}`),
          { statusCode: builtinResponse.status },
        );
      }
      const bridged = bridgeBuiltinResult(normalized.contents, parseAIStudioResponse(builtinResponse.body));
      response = await replay(await makeLoggedBody(bridged, toolGroups.functions, false));
    } else {
      response = await replay(await makeLoggedBody(normalized.contents, effectiveTools, false));
    }
    if (response.status < 200 || response.status >= 300) {
      // 上游拒绝时把 wire 请求体落盘，便于定位 400 类协议错误（无需手动开调试）。
      try {
        appendFileSync(join(runtimeRoot, "data", "wire-debug.log"), JSON.stringify({ time: new Date().toISOString(), status: response.status, upstreamBody: response.body.slice(0, 2000), body: lastWireBody ? JSON.parse(lastWireBody) : null }) + "\n");
      } catch { /* debug only */ }
      throw Object.assign(
        new Error(`AI Studio upstream returned HTTP ${response.status}: ${response.body.slice(0, 500)}`),
        { statusCode: response.status },
      );
    }
    const finalParsed = parseAIStudioResponse(response.body);
    if (emptyCandidateResponse(finalParsed)) {
      throw Object.assign(
        new Error("AI Studio upstream returned an empty candidate"),
        { statusCode: 502 },
      );
    }
    if (finalParsed.responseId) options?.onResponseId?.(finalParsed.responseId);
    return toGeminiResponse(finalParsed);
  }

  async inspectAccountProfile(): Promise<AccountProfile> {
    return this.session.inspectAccountProfile();
  }

  async close(): Promise<void> {
    await this.session.close();
  }
}

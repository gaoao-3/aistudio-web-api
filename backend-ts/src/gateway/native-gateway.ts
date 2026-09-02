import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { runtimeRoot } from "../config.js";
import { NativeBrowserSession, type AuthRefreshResult, type BrowserReplayResponse } from "./browser-session.js";
import { normalizeGeminiRequest, type NormalizedGeminiRequest } from "./gemini-normalize.js";
import { parseAIStudioResponse, toGeminiResponse, type ParsedAIStudioResponse } from "./response-parser.js";
import { encodeCountTokensBody, rewriteWireBody } from "./wire-codec.js";
import type { AistudioContent, AistudioPart } from "./wire-codec.js";
import { fetchCountTokens, fetchModelCatalog } from "./model-catalog.js";
import { validateGenerationConfig } from "./generation-limits.js";
import { IncrementalAIStudioParser } from "./incremental-parser.js";
import { assertProtocolCapability } from "./protocol-capabilities.js";
import type { AccountProfile } from "../accounts/account-profile.js";

const MODEL_CATALOG_CACHE_TTL_MS = 15 * 60 * 1000;

export interface NativeGenerationOptions {
  readonly previousResponseId?: string | null;
  readonly onResponseId?: (responseId: string) => void;
}

export interface UpstreamQuotaInfo {
  readonly reason: "quota_exceeded" | "per_user_quota" | "rate_limit";
  readonly retryAfterMs?: number;
  readonly quotaMetric?: string;
  readonly quotaId?: string;
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
function parseRetryAfter(body: string, headers?: Readonly<Record<string, string>>): number | undefined {
  const header = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === "retry-after")?.[1]?.trim();
  if (header) {
    if (/^\d+(?:\.\d+)?$/u.test(header)) {
      const seconds = Number(header);
      if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
    }
    const timestamp = Date.parse(header);
    if (Number.isFinite(timestamp)) return Math.max(0, timestamp - Date.now());
  }
  const milliseconds = /(?:retryAfterMs|retry_after_ms)\D+(\d+(?:\.\d+)?)/iu.exec(body);
  if (milliseconds) {
    const value = Number(milliseconds[1]);
    if (Number.isFinite(value) && value >= 0) return Math.ceil(value);
  }
  const delay = /(?:retryDelay|retry[-_ ]?after|retry_after)\D+(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|s)?/iu.exec(body);
  if (!delay) return undefined;
  const value = Number(delay[1]);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return Math.ceil(value * (/^(?:milliseconds?|ms)$/iu.test(delay[2] ?? "") ? 1 : 1000));
}

function bodyField(body: string, name: "quotaMetric" | "quota_metric" | "quotaId" | "quota_id"): string | undefined {
  const match = new RegExp(`["']?${name}["']?\\s*[:=]\\s*["']?([^"',}\\s]+)`, "iu").exec(body);
  return match?.[1];
}

export function detectUpstreamQuota(
  status: number,
  body: string,
  headers?: Readonly<Record<string, string>>,
): UpstreamQuotaInfo | undefined {
  const lower = body.toLowerCase();
  const perUserQuota = lower.includes("peruserquota");
  const quotaExceeded = /resource[_ ]exhausted|quota exceeded|exceeded your current quota|quota[_ ]failure/u.test(lower);
  const rateLimited = status === 429 || /too many requests|rate[- ]?limit/u.test(lower);
  if (!perUserQuota && !quotaExceeded && !rateLimited) return undefined;
  const retryAfterMs = parseRetryAfter(body, headers);
  const quotaMetric = bodyField(body, "quotaMetric") ?? bodyField(body, "quota_metric");
  const quotaId = bodyField(body, "quotaId") ?? bodyField(body, "quota_id");
  return {
    reason: perUserQuota ? "per_user_quota" : quotaExceeded ? "quota_exceeded" : "rate_limit",
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(quotaMetric ? { quotaMetric } : {}),
    ...(quotaId ? { quotaId } : {}),
  };
}

function upstreamResponseError(prefix: string, response: BrowserReplayResponse): Error {
  const quotaInfo = detectUpstreamQuota(response.status, response.body, response.headers);
  return Object.assign(
    new Error(`${prefix} HTTP ${response.status}: ${response.body.slice(0, 500)}`),
    { statusCode: response.status, ...(quotaInfo ? { quotaInfo } : {}) },
  );
}

function retryableUpstreamError(message: string, raw: string): Error {
  const responseBytes = Buffer.byteLength(raw, "utf8");
  if (process.env.AISTUDIO_DEBUG_WIRE === "1") {
    try {
      appendFileSync(join(runtimeRoot, "data", "wire-debug.log"), JSON.stringify({
        time: new Date().toISOString(),
        kind: "response-parse-error",
        responseBytes,
        upstreamBody: raw.slice(0, 2000),
      }) + "\n");
    } catch { /* debug only */ }
  }
  return Object.assign(
    new Error(`${message} (${responseBytes} response bytes)`),
    { statusCode: 502, retryable: true },
  );
}

function parseUpstreamResponse(raw: string): ParsedAIStudioResponse {
  try {
    return parseAIStudioResponse(raw);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    throw retryableUpstreamError(error.message, raw);
  }
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
    this.modelCache = { models: structuredClone(models), expires: Date.now() + MODEL_CATALOG_CACHE_TTL_MS };
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
    const replay = async (wireBody: string): Promise<BrowserReplayResponse> => {
      if (!onResponse) return this.session.replay(wireBody, undefined, signal);
      const parser = new IncrementalAIStudioParser();
      return this.session.replayStream(wireBody, raw => {
        for (const chunk of parser.feed(raw)) {
          const parsed = parseUpstreamResponse(JSON.stringify(chunk));
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
    let response: BrowserReplayResponse;
    if (emulateMixedTools && !hasFunctionResponse(normalized.contents)) {
      const builtinResponse = await this.session.replay(await makeLoggedBody(normalized.contents, toolGroups.builtins, false), undefined, signal);
      if (builtinResponse.status < 200 || builtinResponse.status >= 300) {
        throw upstreamResponseError("AI Studio built-in tool phase returned", builtinResponse);
      }
      const bridged = bridgeBuiltinResult(normalized.contents, parseUpstreamResponse(builtinResponse.body));
      response = await replay(await makeLoggedBody(bridged, toolGroups.functions, false));
    } else {
      response = await replay(await makeLoggedBody(normalized.contents, effectiveTools, false));
    }
    if (response.status < 200 || response.status >= 300) {
      const quotaInfo = detectUpstreamQuota(response.status, response.body, response.headers);
      // 上游拒绝时把 wire 请求体落盘，便于定位 400 类协议错误（无需手动开调试）。
      try {
        appendFileSync(join(runtimeRoot, "data", "wire-debug.log"), JSON.stringify({ time: new Date().toISOString(), status: response.status, ...(quotaInfo ? { quotaInfo } : {}), upstreamBody: response.body.slice(0, 2000), body: lastWireBody ? JSON.parse(lastWireBody) : null }) + "\n");
      } catch { /* debug only */ }
      throw upstreamResponseError("AI Studio upstream returned", response);
    }
    const finalParsed = parseUpstreamResponse(response.body);
    if (emptyCandidateResponse(finalParsed)) {
      throw retryableUpstreamError("AI Studio upstream returned an empty candidate", response.body);
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

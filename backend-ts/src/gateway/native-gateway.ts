import { NativeBrowserSession } from "./browser-session.js";
import { normalizeGeminiRequest } from "./gemini-normalize.js";
import { parseAIStudioResponse, toGeminiResponse } from "./response-parser.js";
import { rewriteWireBody } from "./wire-codec.js";
import type { AistudioContent, AistudioPart } from "./wire-codec.js";
import { fetchModelCatalog } from "./model-catalog.js";
import { IncrementalAIStudioParser } from "./incremental-parser.js";
import type { AccountProfile } from "../accounts/account-profile.js";

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

function bridgeBuiltinResult(contents: readonly AistudioContent[], parsed: ReturnType<typeof parseAIStudioResponse>): AistudioContent[] {
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

export function functionResponseRejected(status: number, body: string): boolean {
  if (status < 400) return false;
  const lowered = body.toLowerCase();
  return [
    "permission",
    "禁止访问",
    "invalid value",
    "unexpected list for single non-message field",
    "request contains an invalid argument",
  ].some(marker => lowered.includes(marker));
}

export function functionResponseStalled(status: number, body: string): boolean {
  if (status < 200 || status >= 300) return false;
  try {
    const candidate = parseAIStudioResponse(body).candidate;
    return !candidate.text && !candidate.parts.some(part => "functionCall" in part || "inlineData" in part);
  } catch {
    return false;
  }
}

function hasFunctionResponse(contents: readonly AistudioContent[]): boolean {
  return contents.some(content => content.parts.some(part => Boolean(part.functionResponse)));
}

export function flattenFunctionContents(contents: readonly AistudioContent[]): AistudioContent[] {
  const lines: string[] = [];
  const media: AistudioPart[] = [];
  for (const content of contents) {
    for (const part of content.parts) {
      if (part.functionCall) lines.push(`[assistant tool call: ${part.functionCall[0]}]\n${JSON.stringify(part.functionCall[1])}`);
      else if (part.functionResponse) lines.push(`[tool result: ${part.functionResponse[0]}]\n${JSON.stringify(part.functionResponse[1])}`);
      else if (part.text) lines.push(part.text);
      // Media parts are not representable as text; keep them so the fallback
      // replay does not silently drop images/audio/documents attached to the
      // timeline (e.g. a user image sent after a tool exchange).
      else if (part.inlineData || part.fileId) media.push(part);
    }
  }
  return [{ role: "user", parts: [{ text: lines.join("\n\n") }, ...media] }];
}

export class NativeGateway {
  private modelCache: { readonly expires: number; readonly models: Record<string, unknown>[] } | undefined;
  constructor(private readonly session = new NativeBrowserSession()) {}

  async warmup(): Promise<void> {
    await this.session.warmup();
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

  async generate(model: string, body: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.generateInternal(model, body, undefined, signal);
  }

  async generateStream(
    model: string,
    body: unknown,
    onResponse: (response: Record<string, unknown>) => void,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    return this.generateInternal(model, body, onResponse, signal);
  }

  private async generateInternal(
    model: string,
    body: unknown,
    onResponse?: (response: Record<string, unknown>) => void,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const normalized = normalizeGeminiRequest(model, body);
    const template = await this.session.captureTemplate(normalized.model);
    const generation = normalized.generationConfig;
    const makeBody = async (
      contents: readonly AistudioContent[],
      tools: unknown[][] | null,
      sanitizePlainText: boolean,
      disableThinking = false,
    ): Promise<string> => {
      const snapshot = await this.session.generateSnapshot(contents);
      return rewriteWireBody(template.body, {
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
        disableThinking: disableThinking || normalized.model.toLowerCase().includes("gemini-2.5-flash-image"),
      });
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
      const builtinResponse = await this.session.replay(await makeBody(normalized.contents, toolGroups.builtins, false), undefined, signal);
      if (builtinResponse.status < 200 || builtinResponse.status >= 300) {
        throw Object.assign(
          new Error(`AI Studio built-in tool phase returned HTTP ${builtinResponse.status}: ${builtinResponse.body.slice(0, 500)}`),
          { statusCode: builtinResponse.status },
        );
      }
      const bridged = bridgeBuiltinResult(normalized.contents, parseAIStudioResponse(builtinResponse.body));
      response = await replay(await makeBody(bridged, toolGroups.functions, false));
    } else {
      response = await replay(await makeBody(normalized.contents, effectiveTools, false));
    }
    const needsFunctionFallback = functionResponseRejected(response.status, response.body)
      || (emulateMixedTools && functionResponseStalled(response.status, response.body));
    let flattened: AistudioContent[] | undefined;
    if (needsFunctionFallback && hasFunctionResponse(normalized.contents)) {
      flattened = flattenFunctionContents(normalized.contents);
      if (emulateMixedTools) {
        response = await replay(await makeBody(flattened, null, true, true));
      } else {
        response = await replay(await makeBody(flattened, effectiveTools, true, true));
        if (functionResponseRejected(response.status, response.body)) {
          response = await replay(await makeBody(flattened, null, true, true));
        }
      }
    }
    if (flattened && functionResponseStalled(response.status, response.body)) {
      const finalContents: AistudioContent[] = [
        ...flattened,
        {
          role: "user",
          parts: [{ text: "The tool result is complete. Return the final answer now in plain text. Do not call any more tools." }],
        },
      ];
      response = await replay(await makeBody(finalContents, null, true, true));
    }
    if (response.status < 200 || response.status >= 300) {
      throw Object.assign(
        new Error(`AI Studio upstream returned HTTP ${response.status}: ${response.body.slice(0, 500)}`),
        { statusCode: response.status },
      );
    }
    return toGeminiResponse(parseAIStudioResponse(response.body));
  }

  async inspectAccountProfile(): Promise<AccountProfile> {
    return this.session.inspectAccountProfile();
  }

  async close(): Promise<void> {
    await this.session.close();
  }
}

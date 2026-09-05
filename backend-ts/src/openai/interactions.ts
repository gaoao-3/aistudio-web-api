/**
 * Gemini Interactions API (v1beta, 2026-05-20 revision) <-> AI Studio adapter.
 *
 * Interactions API 是 Gemini 的新一代协议（interactions.create + steps 时间轴
 * + previous_interaction_id 服务器端状态）。AI Studio 页面 wire 仍为
 * generateContent 形状，因此本层把 Interactions 请求翻译成 Gemini contents，
 * 再把上游响应组装为 Interaction 资源（步骤数组）。
 *
 * 与 Responses 适配层同构：
 * - previous_interaction_id → 进程内会话重放（内存，不落盘）
 * - function_call 步骤只在客户端回传对应 function_result 时重放（Gemini
 *   函数配对约束）
 * - 服务器端工具步骤（google_search_call 等）由 AI Studio 页面在 wire 层
 *   执行，本层无法还原中间步骤，因此只暴露 model_output / thought /
 *   function_call 步骤（客户端 SDK 的 output_text 不受影响）。
 */

import { randomUUID } from "node:crypto";
import { OpenAiRequestError, rememberThoughtSignature } from "./convert.js";

export interface ConvertedInteractionsRequest {
  readonly model: string;
  readonly geminiBody: Record<string, unknown>;
  readonly stream: boolean;
  readonly store: boolean;
  readonly previousInteractionId?: string;
  readonly interactionId: string;
  readonly scope?: string;
  readonly background?: boolean;
}

export interface InteractionSession {
  readonly model: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  /** 上次交互的输出步骤（thought / function_call / model_output）。 */
  readonly steps: Record<string, unknown>[];
  readonly contents?: Record<string, unknown>[];
}

const SESSION_TTL_MS = 10 * 60 * 1000;
const SESSION_MAX = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string, code?: string, statusCode = 400): never {
  throw new OpenAiRequestError(statusCode, message, code);
}

function randomId(prefix: string): string {
  return `${prefix}${randomUUID()}`;
}

function parseArgs(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed: unknown = value ? JSON.parse(value) : {};
      return isRecord(parsed) ? parsed : {};
    } catch {
      fail("function_call 的 arguments 不是合法 JSON", "invalid_arguments");
    }
  }
  return {};
}

/* ------------------------------------------------------------------ */
/* Session store                                                       */
/* ------------------------------------------------------------------ */

export class InteractionSessionStore {
  private readonly sessions = new Map<string, InteractionSession>();

  constructor(
    private readonly ttlMs = SESSION_TTL_MS,
    private readonly max = SESSION_MAX,
  ) {}

  remember(interactionId: string, model: string, steps: Record<string, unknown>[], contents?: Record<string, unknown>[], scope = ""): void {
    if (!interactionId) return;
    this.purge();
    this.sessions.set(JSON.stringify([scope, interactionId]), {
      model,
      createdAt: Date.now(),
      expiresAt: Date.now() + Math.max(1_000, this.ttlMs),
      steps: structuredClone(steps),
      ...(contents ? { contents: structuredClone(contents) } : {}),
    });
    while (this.sessions.size > Math.max(1, this.max)) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
  }

  find(interactionId: string, scope = ""): InteractionSession | undefined {
    this.purge();
    const session = this.sessions.get(JSON.stringify([scope, interactionId]));
    return session ? structuredClone(session) : undefined;
  }

  get size(): number {
    this.purge();
    return this.sessions.size;
  }

  clear(): void {
    this.sessions.clear();
  }

  private purge(now = Date.now()): void {
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(id);
    }
  }
}

/** 进程内交互会话存储：previous_interaction_id 重放依赖。只存内存，不落盘。 */
export const interactionSessions = new InteractionSessionStore();

/* ------------------------------------------------------------------ */
/* Request conversion                                                  */
/* ------------------------------------------------------------------ */

function convertContentBlock(block: unknown): Record<string, unknown> {
  if (typeof block === "string") return { text: block };
  if (!isRecord(block)) fail("input 内容块必须是对象");
  switch (block.type) {
    case "text": {
      const text = typeof block.text === "string" ? block.text : "";
      return { text };
    }
    case "image":
    case "audio":
    case "video":
    case "file": {
      const mimeType = typeof block.mime_type === "string" ? block.mime_type : "application/octet-stream";
      const data = typeof block.data === "string" ? block.data : "";
      if (!data) fail(`${block.type} 内容块缺少 data`);
      return { inlineData: { mimeType, data } };
    }
    default:
      fail(`不支持的输入内容块类型: ${String(block.type)}`, "unsupported_input_type");
  }
}

function convertInputSteps(
  input: unknown,
  sessionCallNames?: ReadonlyMap<string, string>,
): {
  readonly contents: Record<string, unknown>[];
} {
  if (typeof input === "string")
    return { contents: [{ role: "user", parts: [{ text: input }] }] };
  if (isRecord(input)) input = [input];
  if (!Array.isArray(input) || input.length === 0)
    fail("input 必须是非空字符串或数组", "missing_input");

  const contentTypes = new Set(["text", "image", "audio", "video", "file"]);
  if (input.every((item) => isRecord(item) && contentTypes.has(String(item.type))))
    return { contents: [{ role: "user", parts: input.map(convertContentBlock) }] };
  const callNames = new Map(sessionCallNames);

  const contents: Record<string, unknown>[] = [];
  // 输入元素可能是内容块（{type:"text"}）或步骤（{type:"user_input", content}）
  for (const [index, raw] of input.entries()) {
    if (!isRecord(raw)) fail(`input[${index}] 必须是对象`);
    switch (raw.type) {
      case "user_input": {
        const blocks = Array.isArray(raw.content) ? raw.content : [raw.content];
        contents.push({ role: "user", parts: blocks.length ? blocks.map(convertContentBlock) : [{ text: "" }] });
        break;
      }
      case "model_output": {
        const blocks = Array.isArray(raw.content) ? raw.content : [];
        const parts = blocks.map(convertContentBlock);
        contents.push({ role: "model", parts: parts.length ? parts : [{ text: "" }] });
        break;
      }
      case "thought": {
        const summary = Array.isArray(raw.summary)
          ? (raw.summary as unknown[])
              .filter(isRecord)
              .map((item) => (typeof item.text === "string" ? item.text : ""))
              .join("")
          : "";
        contents.push({
          role: "model",
          parts: [
            {
              text: summary,
              thought: true,
              ...(typeof raw.signature === "string" && raw.signature
                ? { thoughtSignature: raw.signature }
                : {}),
            },
          ],
        });
        break;
      }
      case "function_call": {
        const name = typeof raw.name === "string" ? raw.name : "";
        const callId = typeof raw.id === "string" && raw.id ? raw.id : undefined;
        if (!name) fail(`input[${index}] function_call 缺少 name`);
        if (callId) callNames.set(callId, name);
        contents.push({
          role: "model",
          parts: [
            {
              functionCall: {
                name,
                args: parseArgs(raw.arguments),
                ...(callId ? { id: callId } : {}),
              },
              ...(typeof raw.signature === "string" && raw.signature
                ? { thoughtSignature: raw.signature }
                : {}),
            },
          ],
        });
        break;
      }
      case "function_result": {
        const callId = typeof raw.call_id === "string" && raw.call_id ? raw.call_id : undefined;
        const name =
          (typeof raw.name === "string" && raw.name ? raw.name : undefined) ??
          (callId ? callNames.get(callId) : undefined);
        if (!callId && !name) fail(`input[${index}] function_result 缺少 call_id`);
        contents.push({
          role: "user",
          parts: [
            {
              functionResponse: {
                name: name ?? "unknown",
                response: raw.result !== undefined ? raw.result : raw.output ?? {},
                ...(callId ? { id: callId } : {}),
              },
            },
          ],
        });
        break;
      }
      default: {
        // 无 type 的对象按内容块处理；服务器端工具步骤（google_search_call /
        // code_execution_call 等）无法在 wire 层还原，直接跳过。
        if (raw.type === undefined) {
          contents.push({ role: "user", parts: [convertContentBlock(raw)] });
        } else if (
          typeof raw.type === "string" &&
          (raw.type.endsWith("_call") || raw.type.endsWith("_result"))
        ) {
          continue; // 服务器端工具步骤：跳过（由 AI Studio 页面执行）
        } else {
          fail(`input[${index}] 不支持的步骤类型: ${String(raw.type)}`, "unsupported_step_type");
        }
      }
    }
  }
  return { contents };
}

function replaySessionContents(
  session: InteractionSession | undefined,
  inputSteps: unknown[],
): Record<string, unknown>[] {
  if (!session) return [];
  if (session.contents) {
    // Keep completed historical pairs, and replay pending calls only when answered.
    const answered = new Set<string>();
    for (const content of session.contents) {
      for (const part of Array.isArray(content.parts) ? content.parts : []) {
        if (isRecord(part) && isRecord(part.functionResponse) && typeof part.functionResponse.id === "string")
          answered.add(part.functionResponse.id);
      }
    }
    for (const step of inputSteps) {
      if (isRecord(step) && step.type === "function_result" && typeof step.call_id === "string") answered.add(step.call_id);
    }
    return session.contents.flatMap((content) => {
      const parts = (Array.isArray(content.parts) ? content.parts : []).filter((part) =>
        !isRecord(part) || !isRecord(part.functionCall) || answered.has(String(part.functionCall.id)));
      return parts.length ? [{ ...content, parts }] : [];
    });
  }
  // 客户端正在推进的工具回合（input 里带对应 function_result）
  const pendingCallIds = new Set<string>();
  for (const step of inputSteps) {
    if (isRecord(step) && step.type === "function_result" && typeof step.call_id === "string") {
      pendingCallIds.add(step.call_id);
    }
  }
  const contents: Record<string, unknown>[] = [];
  for (const step of session.steps) {
    if (!isRecord(step)) continue;
    switch (step.type) {
      case "model_output": {
        const blocks = Array.isArray(step.content) ? step.content : [];
        const parts = blocks.map(convertContentBlock);
        contents.push({ role: "model", parts: parts.length ? parts : [{ text: "" }] });
        break;
      }
      case "thought": {
        const summary = Array.isArray(step.summary)
          ? (step.summary as unknown[])
              .filter(isRecord)
              .map((item) => (typeof item.text === "string" ? item.text : ""))
              .join("")
          : "";
        contents.push({
          role: "model",
          parts: [
            {
              text: summary,
              thought: true,
              ...(typeof step.signature === "string" && step.signature
                ? { thoughtSignature: step.signature }
                : {}),
            },
          ],
        });
        break;
      }
      case "function_call": {
        const callId = typeof step.id === "string" && step.id ? step.id : "";
        // 只重放客户端同步回传 result 的调用，维持 Gemini 函数配对约束
        if (!callId || !pendingCallIds.has(callId)) break;
        const name = typeof step.name === "string" ? step.name : "";
        if (!name) break;
        contents.push({
          role: "model",
          parts: [
            {
              functionCall: { name, args: parseArgs(step.arguments), id: callId },
              ...(typeof step.signature === "string" && step.signature
                ? { thoughtSignature: step.signature }
                : {}),
            },
          ],
        });
        break;
      }
      default:
        break; // 服务器端工具步骤等不重放
    }
  }
  return contents;
}

const BUILTIN_TOOL_TYPES: Readonly<Record<string, string>> = {
  google_search: "googleSearch",
  image_search: "imageSearch",
  code_execution: "codeExecution",
  google_maps: "googleMaps",
  url_context: "urlContext",
};

export function convertInteractionsRequest(body: unknown, scope = ""): ConvertedInteractionsRequest {
  if (!isRecord(body)) fail("请求体必须是 JSON 对象");
  const model = typeof body.model === "string" ? body.model.trim().replace(/^models\//u, "") : "";
  if (!model) fail("缺少必填字段: model", "missing_model");
  if (model.includes(":")) fail("model 只能是模型 ID", "invalid_model");
  if (body.input === undefined) fail("缺少必填字段: input", "missing_input");
  if (body.background === true && (body.store === false || body.stream === true))
    fail("background=true 需要 store=true 且 stream=false", "invalid_background");

  const inputSteps = Array.isArray(body.input) ? body.input : [body.input];
  const previousInteractionId =
    typeof body.previous_interaction_id === "string" ? body.previous_interaction_id : undefined;
  const store = body.store !== false;
  const session =
    previousInteractionId ? interactionSessions.find(previousInteractionId, scope) : undefined;
  if (previousInteractionId && !session)
    fail(`previous_interaction_id 无效或已过期: ${previousInteractionId}`, "invalid_interaction_id", 404);

  // 上一轮输出的 function_call（id → name），供 function_result 回传时补名
  const sessionCallNames = new Map<string, string>();
  for (const content of session?.contents ?? []) {
    for (const part of Array.isArray(content.parts) ? content.parts : []) {
      if (isRecord(part) && isRecord(part.functionCall) && typeof part.functionCall.id === "string" && typeof part.functionCall.name === "string")
        sessionCallNames.set(part.functionCall.id, part.functionCall.name);
    }
  }
  for (const step of session?.steps ?? []) {
    if (isRecord(step) && step.type === "function_call") {
      const callId = typeof step.id === "string" ? step.id : "";
      const name = typeof step.name === "string" ? step.name : "";
      if (callId && name) sessionCallNames.set(callId, name);
    }
  }
  const convertedInput = convertInputSteps(body.input, sessionCallNames);
  const replay = replaySessionContents(session, inputSteps);
  const contents = [...replay, ...convertedInput.contents];
  if (contents.length === 0) fail("input 中至少需要一条消息", "empty_input");

  // 工具：function 声明（顶层 name 形状）+ Gemini 服务器端工具
  const tools: Record<string, unknown>[] = [];
  const builtinKeys: Record<string, unknown> = {};
  for (const tool of Array.isArray(body.tools) ? body.tools : []) {
    if (!isRecord(tool)) fail("tools[] 必须是对象");
    if (tool.type === "function" || tool.type === undefined) {
      const name = typeof tool.name === "string" ? tool.name : "";
      if (!name) fail("tools[].name 必须是非空字符串");
      tools.push({
        type: "function",
        name,
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        ...(isRecord(tool.parameters) ? { parameters: tool.parameters } : {}),
      });
      continue;
    }
    const key = BUILTIN_TOOL_TYPES[String(tool.type)];
    if (key) {
      builtinKeys[key] = {};
      continue;
    }
    fail(`不支持的 tools[].type: ${String(tool.type)}`, "unsupported_tool_type");
  }

  const geminiBody: Record<string, unknown> = { contents };
  if (typeof body.system_instruction === "string" && body.system_instruction.trim()) {
    geminiBody.systemInstruction = {
      role: "user",
      parts: [{ text: body.system_instruction.trim() }],
    };
  }
  if (tools.length) geminiBody.tools = [{ functionDeclarations: tools }];
  if (Object.keys(builtinKeys).length) {
    geminiBody.tools = [...(Array.isArray(geminiBody.tools) ? geminiBody.tools : []), builtinKeys];
  }

  const generationConfig: Record<string, unknown> = {};
  const rawGeneration = isRecord(body.generation_config) ? body.generation_config : {};
  const numberField = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const temperature = numberField(rawGeneration.temperature);
  if (temperature !== undefined) generationConfig.temperature = temperature;
  const topP = numberField(rawGeneration.top_p);
  if (topP !== undefined) generationConfig.topP = topP;
  const topK = numberField(rawGeneration.top_k);
  if (topK !== undefined) generationConfig.topK = topK;
  const maxTokens =
    numberField(rawGeneration.max_output_tokens) ?? numberField(rawGeneration.max_tokens);
  if (maxTokens !== undefined) generationConfig.maxOutputTokens = Math.floor(maxTokens);
  const seed = numberField(rawGeneration.seed);
  if (seed !== undefined) generationConfig.seed = seed;
  if (Array.isArray(rawGeneration.stop_sequences) && rawGeneration.stop_sequences.length) {
    generationConfig.stopSequences = rawGeneration.stop_sequences.map(String);
  }
  const thinkingLevel = typeof rawGeneration.thinking_level === "string" ? rawGeneration.thinking_level : undefined;
  if (thinkingLevel) {
    const level = thinkingLevel.toUpperCase();
    if (["LOW", "MEDIUM", "HIGH", "MINIMAL"].includes(level))
      generationConfig.thinkingConfig = { thinkingLevel: level };
  }
  // response_format：统一多态输出格式 → Gemini 结构化输出/图像输出
  const responseFormat = body.response_format;
  const formatList = Array.isArray(responseFormat)
    ? responseFormat
    : responseFormat !== undefined ? [responseFormat] : [];
  for (const format of formatList) {
    if (!isRecord(format)) fail("response_format 条目必须是对象");
    const type = typeof format.type === "string" ? format.type : "text";
    if (type === "audio") fail("response_format 的 audio 输出暂不支持", "unsupported_audio_output");
    if (type === "image") {
      if (typeof format.aspect_ratio === "string" || typeof format.image_size === "string") {
        generationConfig.imageConfig = {
          ...(typeof format.aspect_ratio === "string" ? { aspectRatio: format.aspect_ratio } : {}),
          ...(typeof format.image_size === "string" ? { imageSize: format.image_size } : {}),
        };
      }
    }
    if (type === "text") {
      const schema = isRecord(format.schema) ? format.schema : isRecord(format.json_schema) ? format.json_schema : undefined;
      if (schema) {
        generationConfig.responseSchema = schema;
        if (generationConfig.responseMimeType === undefined)
          generationConfig.responseMimeType = "application/json";
      } else if (format.mime_type === "application/json") {
        generationConfig.responseMimeType = "application/json";
      }
    }
  }
  const wantsImage = formatList.some((format) => isRecord(format) && format.type === "image");
  const wantsText = formatList.length === 0 || formatList.some((format) => isRecord(format) && (format.type === "text" || format.type === undefined));
  if (wantsImage) {
    generationConfig.responseModalities = wantsText ? ["TEXT", "IMAGE"] : ["IMAGE"];
  }
  if (Object.keys(generationConfig).length)
    geminiBody.generationConfig = generationConfig;

  return {
    model,
    geminiBody,
    stream: body.stream === true,
    store,
    ...(previousInteractionId ? { previousInteractionId } : {}),
    interactionId: randomId("int_"),
    scope,
    background: body.background === true,
  };
}

/* ------------------------------------------------------------------ */
/* Response conversion (non-streaming)                                 */
/* ------------------------------------------------------------------ */

function candidateOf(response: unknown): Record<string, unknown> {
  if (!isRecord(response) || !Array.isArray(response.candidates) || !isRecord(response.candidates[0]))
    fail("上游返回了无效的 Gemini 响应（缺少 candidates）", "upstream_error", 502);
  return response.candidates[0];
}

function partsOf(candidate: Record<string, unknown>): Record<string, unknown>[] {
  const content = candidate.content;
  if (!isRecord(content) || !Array.isArray(content.parts)) return [];
  return content.parts.filter(isRecord);
}

function usageOf(response: unknown): Record<string, unknown> | undefined {
  if (!isRecord(response) || !isRecord(response.usageMetadata)) return undefined;
  const meta = response.usageMetadata;
  return {
    total_input_tokens: typeof meta.promptTokenCount === "number" ? meta.promptTokenCount : 0,
    total_output_tokens: typeof meta.candidatesTokenCount === "number" ? meta.candidatesTokenCount : 0,
    total_thought_tokens: typeof meta.thoughtsTokenCount === "number" ? meta.thoughtsTokenCount : 0,
    total_cached_tokens: typeof meta.cachedContentTokenCount === "number" ? meta.cachedContentTokenCount : 0,
    prompt_tokens: typeof meta.promptTokenCount === "number" ? meta.promptTokenCount : 0,
    completion_tokens:
      (typeof meta.candidatesTokenCount === "number" ? meta.candidatesTokenCount : 0) +
      (typeof meta.thoughtsTokenCount === "number" ? meta.thoughtsTokenCount : 0),
    total_tokens: typeof meta.totalTokenCount === "number" ? meta.totalTokenCount : 0,
  };
}

function mediaContent(part: Record<string, unknown>): Record<string, unknown> | undefined {
  const inline = part.inlineData;
  if (!isRecord(inline) || typeof inline.mimeType !== "string" || typeof inline.data !== "string") return undefined;
  const type = inline.mimeType.startsWith("audio/") ? "audio" : inline.mimeType.startsWith("video/") ? "video" : inline.mimeType.startsWith("image/") ? "image" : "file";
  return { type, mime_type: inline.mimeType, data: inline.data };
}

export function toInteractionSteps(response: unknown): Record<string, unknown>[] {
  const candidate = candidateOf(response);
  const steps: Record<string, unknown>[] = [];
  let content: Record<string, unknown>[] = [];

  const flushText = (): void => {
    if (content.length) steps.push({ type: "model_output", content });
    content = [];
  };

  for (const part of partsOf(candidate)) {
    if (part.thought === true || (typeof part.thoughtSignature === "string" && !part.text && !part.functionCall && !part.inlineData)) {
      flushText();
      steps.push({
        type: "thought",
        summary: typeof part.text === "string" && part.text ? [{ type: "text", text: part.text }] : [],
        ...(typeof part.thoughtSignature === "string" && part.thoughtSignature
          ? { signature: part.thoughtSignature }
          : {}),
      });
      continue;
    }
    if (typeof part.text === "string" && part.text && part.thought !== true) {
      content.push({ type: "text", text: part.text, ...(typeof part.thoughtSignature === "string" ? { signature: part.thoughtSignature } : {}) });
      continue;
    }
    if (isRecord(part.inlineData)) {
      const media = mediaContent(part);
      if (media) content.push({ ...media, ...(typeof part.thoughtSignature === "string" ? { signature: part.thoughtSignature } : {}) });
      continue;
    }
    if (isRecord(part.functionCall)) {
      flushText();
      const call = part.functionCall;
      const callId = typeof call.id === "string" && call.id ? call.id : randomId("fc_");
      rememberThoughtSignature(callId, part.thoughtSignature);
      steps.push({
        type: "function_call",
        id: callId,
        name: call.name,
        arguments: isRecord(call.args) ? call.args : {},
        ...(typeof part.thoughtSignature === "string" && part.thoughtSignature
          ? { signature: part.thoughtSignature }
          : {}),
      });
    }
  }
  flushText();
  return steps;
}

function persistInteraction(converted: ConvertedInteractionsRequest, steps: Record<string, unknown>[], outputParts?: Record<string, unknown>[]): void {
  if (!converted.store) return;
  const calls = steps.filter((step) => step.type === "function_call");
  let callIndex = 0;
  const output = outputParts ? [{ role: "model", parts: outputParts.map((part) => {
    if (!isRecord(part.functionCall)) return part;
    const step = calls[callIndex++];
    return { ...part, functionCall: { ...part.functionCall, id: step?.id ?? part.functionCall.id } };
  }) }] : (steps.length ? convertInputSteps(steps).contents : []);
  const input = Array.isArray(converted.geminiBody.contents) ? converted.geminiBody.contents.filter(isRecord) : [];
  interactionSessions.remember(converted.interactionId, converted.model, steps, [...input, ...output], converted.scope);
}

export function toInteractionResponse(
  response: unknown,
  converted: ConvertedInteractionsRequest,
): Record<string, unknown> {
  const steps = toInteractionSteps(response);
  if (converted.store && steps.length > 0) {
    persistInteraction(converted, steps, partsOf(candidateOf(response)));
  }
  return {
    id: converted.interactionId,
    object: "interaction",
    model: converted.model,
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    status: candidateOf(response).finishReason === "MAX_TOKENS" ? "incomplete" : steps.some((step) => step.type === "function_call") ? "requires_action" : "completed",
    ...(converted.previousInteractionId ? { previous_interaction_id: converted.previousInteractionId } : {}),
    store: converted.store,
    steps,
    ...(usageOf(response) ? { usage: usageOf(response) } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Response conversion (streaming)                                     */
/* ------------------------------------------------------------------ */

export interface InteractionsStreamEncoder {
  feed(response: unknown): string[];
  finish(finalResponse: unknown): string[];
  /** Full interaction result (including steps) after the stream ends; used for persistence. */
  result(finalResponse: unknown): Record<string, unknown>;
}

function sse(type: string, payload: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ ...payload, event_type: type })}\n\n`;
}

export function createInteractionsStreamEncoder(
  converted: ConvertedInteractionsRequest,
): InteractionsStreamEncoder {
  let started = false;
  let finalized = false;
  // 各 step 的累积状态
  const steps: Record<string, unknown>[] = [];
  let modelStep: { index: number; text: string } | undefined;
  let thoughtStepIndex: number | undefined;
  const emittedCallIds = new Set<string>();

  const start = (): string[] => {
    if (started) return [];
    started = true;
    const interaction = {
      id: converted.interactionId,
      object: "interaction",
      model: converted.model,
      status: "in_progress",
      ...(converted.previousInteractionId ? { previous_interaction_id: converted.previousInteractionId } : {}),
    };
    return [
      sse("interaction.created", { interaction }),
      sse("interaction.status_update", { interaction_id: converted.interactionId, status: "in_progress" }),
    ];
  };

  return {
    feed(response: unknown): string[] {
      const frames = start();
      if (!isRecord(response)) return frames;
      const candidate = Array.isArray(response.candidates) && isRecord(response.candidates[0])
        ? response.candidates[0]
        : undefined;
      if (!candidate) return frames;
      const parts = partsOf(candidate);

      for (const part of parts) {
        if (part.thought === true) {
          if (thoughtStepIndex === undefined) {
            thoughtStepIndex = steps.length;
            const step: Record<string, unknown> = {
              type: "thought",
              summary: [{ type: "text", text: "" }],
              ...(typeof part.thoughtSignature === "string" && part.thoughtSignature
                ? { signature: part.thoughtSignature }
                : {}),
            };
            steps.push(step);
            frames.push(sse("step.start", { index: thoughtStepIndex, step: { type: "thought", ...(step.signature ? { signature: step.signature } : {}) } }));
          }
          const summary = steps[thoughtStepIndex]!.summary as unknown[];
          if (typeof part.text === "string" && part.text) {
            if (summary.length > 0 && isRecord(summary[0])) summary[0].text = String(summary[0].text ?? "") + part.text;
            frames.push(sse("step.delta", { index: thoughtStepIndex, delta: { type: "thought_summary", content: { type: "text", text: part.text } } }));
          }
          if (typeof part.thoughtSignature === "string") {
            steps[thoughtStepIndex]!.signature = part.thoughtSignature;
            frames.push(sse("step.delta", { index: thoughtStepIndex, delta: { type: "thought_signature", signature: part.thoughtSignature } }));
          }
          continue;
        }
        const media = mediaContent(part);
        if (media) {
          if (!modelStep) {
            modelStep = { index: steps.length, text: "" };
            steps.push({ type: "model_output", content: [] });
            frames.push(sse("step.start", { index: modelStep.index, step: { type: "model_output" } }));
          }
          (steps[modelStep.index]!.content as unknown[]).push(media);
          modelStep.text = "";
          frames.push(sse("step.delta", { index: modelStep.index, delta: media }));
          continue;
        }
        if (typeof part.text === "string" && part.text && part.thought !== true) {
          if (!modelStep) {
            modelStep = { index: steps.length, text: "" };
            steps.push({ type: "model_output", content: [] });
            frames.push(sse("step.start", { index: modelStep.index, step: { type: "model_output", content: [] } }));
          }
          modelStep.text += part.text;
          const content = steps[modelStep.index]!.content as unknown[];
          if (content.length === 0 || !isRecord(content[content.length - 1]) || (content[content.length - 1] as Record<string, unknown>).type !== "text") {
            content.push({ type: "text", text: part.text });
          } else {
            (content[content.length - 1] as Record<string, unknown>).text = modelStep.text;
          }
          frames.push(sse("step.delta", { index: modelStep.index, delta: { type: "text", text: part.text } }));
          continue;
        }
        if (isRecord(part.functionCall)) {
          if (modelStep) {
            frames.push(sse("step.stop", { index: modelStep.index }));
            modelStep = undefined;
          }
          const call = part.functionCall;
          const callId = typeof call.id === "string" && call.id ? call.id : randomId("fc_");
          if (emittedCallIds.has(callId)) continue;
          emittedCallIds.add(callId);
          rememberThoughtSignature(callId, part.thoughtSignature);
          const argsJson = JSON.stringify(isRecord(call.args) ? call.args : {});
          const fcIndex = steps.length;
          const step: Record<string, unknown> = {
            type: "function_call",
            id: callId,
            name: call.name,
            arguments: isRecord(call.args) ? call.args : {},
            ...(typeof part.thoughtSignature === "string" && part.thoughtSignature
              ? { signature: part.thoughtSignature }
              : {}),
          };
          steps.push(step);
          frames.push(sse("step.start", { index: fcIndex, step: { type: "function_call", id: callId, name: call.name, arguments: {} } }));
          frames.push(sse("step.delta", { index: fcIndex, delta: { type: "arguments_delta", arguments: argsJson } }));
          frames.push(sse("step.stop", { index: fcIndex, status: "done" }));
        }
      }
      return frames;
    },

    finish(finalResponse: unknown): string[] {
      if (finalized) return [];
      const fallback = steps.length === 0 ? this.feed(finalResponse) : [];
      finalized = true;
      const frames = [...fallback, ...start()];
      if (modelStep) {
        const content = steps[modelStep.index]!.content as unknown[];
        frames.push(sse("step.stop", { index: modelStep.index, status: "done" }));
        void content;
      }
      if (thoughtStepIndex !== undefined) {
        frames.push(sse("step.stop", { index: thoughtStepIndex, status: "done" }));
      }
      if (converted.store && steps.length > 0) {
        persistInteraction(converted, steps.slice());
      }
      const status = candidateOf(finalResponse).finishReason === "MAX_TOKENS" ? "incomplete" : steps.some((step) => step.type === "function_call") ? "requires_action" : "completed";
      frames.push(sse("interaction.completed", {
        interaction: {
          id: converted.interactionId,
          object: "interaction",
          model: converted.model,
          status,
          ...(converted.previousInteractionId ? { previous_interaction_id: converted.previousInteractionId } : {}),
          ...(usageOf(finalResponse) ? { usage: usageOf(finalResponse) } : {}),
        },
      }));
      frames.push("data: [DONE]\n\n");
      return frames;
    },

    result(finalResponse: unknown): Record<string, unknown> {
      const status = candidateOf(finalResponse).finishReason === "MAX_TOKENS" ? "incomplete" : steps.some((step) => step.type === "function_call") ? "requires_action" : "completed";
      return {
        id: converted.interactionId,
        object: "interaction",
        model: converted.model,
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        status,
        ...(converted.previousInteractionId ? { previous_interaction_id: converted.previousInteractionId } : {}),
        store: converted.store,
        steps: steps.slice(),
        ...(usageOf(finalResponse) ? { usage: usageOf(finalResponse) } : {}),
      };
    },
  };
}
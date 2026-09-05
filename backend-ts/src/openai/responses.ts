/**
 * OpenAI Responses API <-> Gemini generateContent conversion layer.
 *
 * 与 chat completions 转换器共享同一套 Gemini 转换核心（convertMessages、
 * convertTools、convertGenerationConfig），额外实现：
 * - input 的三种形状：字符串 / legacy messages 数组 / typed items 数组
 * - previous_response_id 状态重放（内存会话：完整历史重放为 Gemini
 *   contents；function_call 只在客户端同步回传对应 function_call_output
 *   时才重放，保证 Gemini 的函数调用配对约束）
 * - 输出组装为 typed items（message / reasoning / function_call）
 * - SSE 流式事件序列（response.created → output_text.delta → completed）
 *
 * 跨轮续接委托给 bridge 的 privateContinuation（callId → 上游 responseId
 * + thought signature），本层不接触上游续接细节。
 */

import { randomUUID } from "node:crypto";
import {
  OpenAiRequestError,
  convertGenerationConfig,
  convertMessages,
  convertToolChoice,
  convertTools,
  convertUserPart,
  rememberThoughtSignature,
  thoughtSignatureOf,
} from "./convert.js";

export interface ConvertedResponsesRequest {
  readonly model: string;
  readonly geminiBody: Record<string, unknown>;
  readonly stream: boolean;
  readonly store: boolean;
  readonly previousResponseId?: string;
  /** Trusted caller identity supplied by the route, never by the request body. */
  readonly callerScope?: string;
  /** 本服务为该请求生成的 response id。 */
  readonly responseId: string;
}

export interface ResponsesSession {
  readonly model: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  /** 上次响应的输出 items，兼容旧 remember 调用。 */
  readonly items: Record<string, unknown>[];
  /** 累积的 Gemini 用户/模型/函数结果历史，保留原生签名。 */
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

function jsonArgs(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value ?? {});
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

export class ResponsesSessionStore {
  private readonly sessions = new Map<string, ResponsesSession>();

  constructor(
    private readonly ttlMs = SESSION_TTL_MS,
    private readonly max = SESSION_MAX,
  ) {}

  remember(responseId: string, model: string, items: Record<string, unknown>[], callerScope = "", contents?: Record<string, unknown>[]): void {
    if (!responseId) return;
    this.purge();
    this.sessions.set(JSON.stringify([callerScope, responseId]), {
      model,
      createdAt: Date.now(),
      expiresAt: Date.now() + Math.max(1_000, this.ttlMs),
      items: structuredClone(items),
      ...(contents ? { contents: structuredClone(contents) } : {}),
    });
    while (this.sessions.size > Math.max(1, this.max)) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
  }

  find(responseId: string, callerScope = ""): ResponsesSession | undefined {
    this.purge();
    const session = this.sessions.get(JSON.stringify([callerScope, responseId]));
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

/** 进程内会话存储：previous_response_id 重放依赖。只存内存，不落盘。 */
export const responseSessions = new ResponsesSessionStore();

/* ------------------------------------------------------------------ */
/* Request conversion                                                  */
/* ------------------------------------------------------------------ */

function convertInputItems(
  input: unknown,
  sessionCallNames?: ReadonlyMap<string, string>,
): {
  readonly contents: Record<string, unknown>[];
  readonly system: string[];
} {
  if (typeof input === "string")
    return {
      contents: [{ role: "user", parts: [{ text: input }] }],
      system: [],
    };
  if (!Array.isArray(input) || input.length === 0)
    fail("input 必须是非空字符串或数组", "missing_input");

  // legacy messages 形状（元素无 type 字段）→ 复用 chat 转换器
  if (input.some((item) => !isRecord(item) || item.type === undefined)) {
    const converted = convertMessages(input as Record<string, unknown>[]);
    return { contents: converted.contents, system: converted.system };
  }

  const contents: Record<string, unknown>[] = [];
  let system: string[] = [];
  const toolNameByCallId = new Map(sessionCallNames);

  for (const [index, item] of input.entries()) {
    if (!isRecord(item)) fail(`input[${index}] 必须是对象`);
    const type = item.type;
    if (type === "message") {
      const role = item.role === "assistant" || item.role === "model" ? "model" : "user";
      const parts: Record<string, unknown>[] = [];
      const content = item.content;
      if (typeof content === "string") {
        if (content) parts.push({ text: content });
      } else if (Array.isArray(content)) {
        for (const part of content) parts.push(convertUserPart(part));
      } else if (content !== undefined && content !== null) {
        fail(`input[${index}].content 必须是字符串或部件数组`);
      }
      contents.push({ role, parts: parts.length ? parts : [{ text: "" }] });
      continue;
    }
    if (type === "function_call") {
      const name = typeof item.name === "string" && item.name ? item.name : "";
      const callId = typeof item.call_id === "string" && item.call_id ? item.call_id : "";
      if (!name) fail(`input[${index}] function_call 缺少 name`);
      if (!callId) fail(`input[${index}] function_call 缺少 call_id`);
      toolNameByCallId.set(callId, name);
      const signature = thoughtSignatureOf(item) ?? thoughtSignatureOf(item.extra_content);
      contents.push({
        role: "model",
        parts: [
          {
            functionCall: { name, args: parseArgs(item.arguments), id: callId },
            ...(signature ? { thoughtSignature: signature } : {}),
          },
        ],
      });
      continue;
    }
    if (type === "function_call_output") {
      const callId = typeof item.call_id === "string" && item.call_id ? item.call_id : "";
      if (!callId) fail(`input[${index}] function_call_output 缺少 call_id`);
      const name =
        (typeof item.name === "string" && item.name ? item.name : undefined) ??
        toolNameByCallId.get(callId);
      if (!name)
        fail(
          `input[${index}] function_call_output 无法确定函数名；请先提供对应的 function_call item 或 name 字段`,
          "unknown_call_id",
        );
      // 与 chat 路径的 tool 消息一致：字符串结果包装为 { result: <值> }
      const response = typeof item.output === "string" ? { result: item.output } : item.output;
      contents.push({
        role: "user",
        parts: [{ functionResponse: { name, response, id: callId } }],
      });
      continue;
    }
    if (type === "reasoning") {
      // OpenAI 的 reasoning item 内容加密，客户端原样回传；代理无法验证，
      // 直接跳过（不进入 Gemini 上下文）。
      continue;
    }
    if (type === "system") {
      const text =
        typeof item.text === "string"
          ? item.text
          : Array.isArray(item.content)
            ? item.content
                .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
                .join("")
            : "";
      if (text) system = [...system, text];
      continue;
    }
    fail(`input[${index}] 不支持的 item 类型: ${String(type)}`, "unsupported_item_type");
  }
  return { contents, system };
}

function replaySessionContents(
  session: ResponsesSession | undefined,
  inputItems: unknown[],
): Record<string, unknown>[] {
  if (!session) return [];
  // 客户端正在推进的 function call 回合（input 里带对应 function_call_output）
  const pendingCallIds = new Set<string>();
  for (const item of inputItems) {
    if (isRecord(item) && item.type === "function_call_output" && typeof item.call_id === "string") {
      pendingCallIds.add(item.call_id);
    }
  }
  if (session.contents) {
    for (const content of session.contents) {
      for (const part of Array.isArray(content.parts) ? content.parts : []) {
        if (isRecord(part) && isRecord(part.functionResponse) && typeof part.functionResponse.id === "string")
          pendingCallIds.add(part.functionResponse.id);
      }
    }
    return structuredClone(session.contents).flatMap((content) => {
      const parts = (Array.isArray(content.parts) ? content.parts : []).filter((part) =>
        !isRecord(part) || !isRecord(part.functionCall) || pendingCallIds.has(String(part.functionCall.id)),
      );
      return parts.length ? [{ ...content, parts }] : [];
    });
  }
  const contents: Record<string, unknown>[] = [];
  for (const item of session.items) {
    if (!isRecord(item)) continue;
    if (item.type === "message") {
      const text = Array.isArray(item.content)
        ? (item.content as unknown[])
            .filter(isRecord)
            .map((part) => (typeof part.text === "string" && part.type === "output_text" ? part.text : ""))
            .join("")
        : "";
      contents.push({ role: "model", parts: [{ text }] });
      continue;
    }
    if (item.type === "function_call") {
      const callId = typeof item.call_id === "string" ? item.call_id : "";
      // 只有客户端同步回传 output 的调用才重放，维持 Gemini 函数配对约束
      if (!callId || !pendingCallIds.has(callId)) continue;
      const name = typeof item.name === "string" ? item.name : "";
      if (!name) continue;
      const signature = thoughtSignatureOf(item);
      contents.push({
        role: "model",
        parts: [
          {
            functionCall: { name, args: parseArgs(item.arguments), id: callId },
            ...(signature ? { thoughtSignature: signature } : {}),
          },
        ],
      });
    }
  }
  return contents;
}

function isSupportedFunctionTool(tool: unknown): boolean {
  return isRecord(tool) && (tool.type === undefined || tool.type === "function");
}

export function convertResponsesRequest(body: unknown, callerScope = ""): ConvertedResponsesRequest {
  if (!isRecord(body)) fail("请求体必须是 JSON 对象");
  const model = typeof body.model === "string" ? body.model.trim().replace(/^models\//u, "") : "";
  if (!model) fail("缺少必填字段: model", "missing_model");
  if (model.includes(":")) fail("model 只能是模型 ID（例如 gemini-3-flash-preview）", "invalid_model");
  if (body.input === undefined) fail("缺少必填字段: input", "missing_input");

  const inputItems = Array.isArray(body.input) ? body.input : [body.input];
  const previousResponseId =
    typeof body.previous_response_id === "string" ? body.previous_response_id : undefined;
  const store = body.store !== false;
  const session = previousResponseId ? responseSessions.find(previousResponseId, callerScope) : undefined;
  if (previousResponseId && !session)
    fail(`previous_response_id 无效或已过期: ${previousResponseId}`, "invalid_response_id", 404);

  // 上一轮输出的 function_call（call_id → name），供 function_call_output 回传时补名
  const sessionCallNames = new Map<string, string>();
  for (const item of session?.items ?? []) {
    if (isRecord(item) && item.type === "function_call") {
      const callId = typeof item.call_id === "string" ? item.call_id : "";
      const name = typeof item.name === "string" ? item.name : "";
      if (callId && name) sessionCallNames.set(callId, name);
    }
  }
  const convertedInput = convertInputItems(body.input, sessionCallNames);
  const replay = replaySessionContents(session, inputItems);
  const contents = [...replay, ...convertedInput.contents];
  if (contents.length === 0)
    fail("input 中至少需要一条 user/assistant/function item", "empty_input");

  for (const tool of Array.isArray(body.tools) ? body.tools : []) {
    if (!isSupportedFunctionTool(tool)) {
      const type = isRecord(tool) ? String(tool.type) : "unknown";
      fail(
        `不支持的 tools[].type: ${type}（当前仅支持 function 类型；内置工具需客户端自行执行）`,
        "unsupported_tool_type",
      );
    }
  }
  // Responses 的 function tool 形状是顶层 name/parameters；convertTools 兼容两者。
  let tools = convertTools(body);
  const toolConfig = convertToolChoice(body, tools !== null);
  if (toolConfig?.mode === "NONE") tools = null;

  const geminiBody: Record<string, unknown> = { contents };
  const systemParts: string[] = [];
  const instructions =
    typeof body.instructions === "string" && body.instructions.trim() ? body.instructions.trim() : "";
  if (instructions) systemParts.push(instructions);
  systemParts.push(...convertedInput.system);
  if (systemParts.length) {
    geminiBody.systemInstruction = { role: "user", parts: [{ text: systemParts.join("\n\n") }] };
  }
  if (tools) geminiBody.tools = [tools];
  if (toolConfig && toolConfig.mode !== "NONE")
    geminiBody.toolConfig = { functionCallingConfig: toolConfig };

  const generationConfig = convertGenerationConfig(body);
  // Responses 的 text.format → Gemini 结构化输出
  const text = isRecord(body.text) ? body.text : undefined;
  const format = isRecord(text?.format) ? text.format : undefined;
  if (format?.type === "json_object") {
    generationConfig.responseMimeType = "application/json";
  } else if (format && format.type === "json_schema") {
    const schema = isRecord(format.schema) ? format.schema : undefined;
    if (!schema)
      fail("text.format.json_schema.schema 必须是 JSON Schema 对象", "invalid_json_schema");
    generationConfig.responseSchema = schema;
    if (generationConfig.responseMimeType === undefined)
      generationConfig.responseMimeType = "application/json";
  } else if (format && typeof format.type === "string" && format.type !== "json_object" && format.type !== "text") {
    fail(`不支持的 text.format.type: ${format.type}`, "unsupported_response_format");
  }
  // Responses 的 reasoning.effort → thinkingLevel（none 无对应开关，忽略）
  if (isRecord(body.reasoning)) {
    const effort = typeof body.reasoning.effort === "string" ? body.reasoning.effort : undefined;
    if (effort) {
      const level = effort.toUpperCase();
      if (["LOW", "MEDIUM", "HIGH", "MINIMAL"].includes(level))
        generationConfig.thinkingConfig = { thinkingLevel: level };
    }
  }
  if (Object.keys(generationConfig).length)
    geminiBody.generationConfig = generationConfig;

  return {
    model,
    geminiBody,
    stream: body.stream === true,
    store,
    callerScope,
    ...(previousResponseId ? { previousResponseId } : {}),
    responseId: randomId("resp_"),
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
  const input = typeof meta.promptTokenCount === "number" ? meta.promptTokenCount : 0;
  const output = typeof meta.candidatesTokenCount === "number" ? meta.candidatesTokenCount : 0;
  const reasoning = typeof meta.thoughtsTokenCount === "number" ? meta.thoughtsTokenCount : 0;
  const total = typeof meta.totalTokenCount === "number" && meta.totalTokenCount > 0
    ? meta.totalTokenCount
    : input + output + reasoning;
  return {
    input_tokens: input,
    output_tokens: output + reasoning,
    total_tokens: total,
    output_tokens_details: { reasoning_tokens: reasoning },
  };
}

export function toResponsesOutputItems(response: unknown): Record<string, unknown>[] {
  const candidate = candidateOf(response);
  const items: Record<string, unknown>[] = [];
  let reasoningId: string | undefined;
  for (const part of partsOf(candidate)) {
    if (part.inlineData || part.fileData) fail("Responses media output is not supported; use Interactions", "unsupported_media_output", 502);
    if (typeof part.text === "string" && part.text && part.thought === true) {
      if (!reasoningId) {
        reasoningId = randomId("r_");
        items.push({ id: reasoningId, type: "reasoning", summary: [{ type: "summary_text", text: "" }] });
      }
      const summary = (items.find((item) => item.id === reasoningId)?.summary as unknown[] | undefined) ?? [];
      if (summary.length > 0 && isRecord(summary[0])) summary[0].text = String(summary[0].text ?? "") + part.text;
      continue;
    }
    if (typeof part.text === "string" && part.text && part.thought !== true) {
      items.push({
        id: randomId("msg_"),
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: part.text, annotations: [] }],
      });
      continue;
    }
    if (isRecord(part.functionCall)) {
      const call = part.functionCall;
      const callId = typeof call.id === "string" && call.id ? call.id : randomId("call_");
      rememberThoughtSignature(callId, part.thoughtSignature);
      items.push({
        id: randomId("fc_"),
        type: "function_call",
        status: "completed",
        call_id: callId,
        name: call.name,
        arguments: jsonArgs(call.args),
        ...(part.thoughtSignature
          ? { extra_content: { google: { thought_signature: part.thoughtSignature } } }
          : {}),
      });
    }
  }
  return items;
}

function rememberResponse(
  converted: ConvertedResponsesRequest,
  items: Record<string, unknown>[],
  outputParts: Record<string, unknown>[],
): void {
  if (!converted.store) return;
  const calls = items.filter((item) => item.type === "function_call");
  let callIndex = 0;
  const parts = structuredClone(outputParts).map((part) => {
    if (isRecord(part.functionCall)) {
      const item = calls[callIndex++];
      if (item) part.functionCall.id = item.call_id;
    }
    return part;
  });
  const input = Array.isArray(converted.geminiBody.contents) ? converted.geminiBody.contents : [];
  responseSessions.remember(converted.responseId, converted.model, items, converted.callerScope, [
    ...input,
    ...(parts.length ? [{ role: "model", parts }] : []),
  ]);
}

export function toResponsesResponse(
  response: unknown,
  converted: ConvertedResponsesRequest,
): Record<string, unknown> {
  const items = toResponsesOutputItems(response);
  rememberResponse(converted, items, partsOf(candidateOf(response)));
  return {
    id: converted.responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: converted.model,
    output: items,
    parallel_tool_calls: true,
    ...(converted.previousResponseId ? { previous_response_id: converted.previousResponseId } : {}),
    store: converted.store,
    usage: usageOf(response) ?? {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
}

/* ------------------------------------------------------------------ */
/* Response conversion (streaming)                                     */
/* ------------------------------------------------------------------ */

export interface ResponsesStreamEncoder {
  /** Convert one Gemini streaming chunk into OpenAI Responses SSE frames. */
  feed(response: unknown): string[];
  /** Emit final item events, response.completed and [DONE]. */
  finish(finalResponse: unknown): string[];
}

function sse(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function responseHeader(converted: ConvertedResponsesRequest, status = "in_progress"): Record<string, unknown> {
  return {
    id: converted.responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model: converted.model,
    output: [],
    parallel_tool_calls: true,
    ...(converted.previousResponseId ? { previous_response_id: converted.previousResponseId } : {}),
    store: converted.store,
  };
}

export function createResponsesStreamEncoder(
  converted: ConvertedResponsesRequest,
): ResponsesStreamEncoder {
  let started = false;
  let finalized = false;
  const pending: Record<string, unknown>[] = [];
  const streamedParts: Record<string, unknown>[] = [];
  // 流式文本/推理按 item 累积：首个增量创建事件，后续增量只发 delta
  let activeText: { item: Record<string, unknown>; part: Record<string, unknown>; outputIndex: number } | undefined;
  let activeReasoning: { item: Record<string, unknown>; outputIndex: number } | undefined;
  const emittedCallIds = new Set<string>();

  const start = (): string[] => {
    if (started) return [];
    started = true;
    const header = responseHeader(converted);
    return [
      sse({ type: "response.created", response: header }),
      sse({ type: "response.in_progress", response: header }),
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
        if (part.inlineData || part.fileData) fail("Responses media output is not supported; use Interactions", "unsupported_media_output", 502);
        if (!isRecord(part.functionCall) || !emittedCallIds.has(String(part.functionCall.id)))
          streamedParts.push(structuredClone(part));
        // 推理增量
        if (typeof part.text === "string" && part.text && part.thought === true) {
          if (!activeReasoning) {
            const item: Record<string, unknown> = {
              id: randomId("r_"),
              type: "reasoning",
              summary: [{ type: "summary_text", text: "" }],
            };
            pending.push(item);
            const outputIndex = pending.indexOf(item);
            activeReasoning = { item, outputIndex };
            frames.push(sse({
              type: "response.output_item.added",
              output_index: outputIndex,
              item: { ...item, summary: [] },
            }));
          }
          const summary = activeReasoning.item.summary as unknown[];
          if (summary.length > 0 && isRecord(summary[0])) summary[0].text = String(summary[0].text ?? "") + part.text;
          frames.push(sse({
            type: "response.reasoning_summary_text.delta",
            item_id: activeReasoning.item.id,
            output_index: activeReasoning.outputIndex,
            summary_index: 0,
            delta: part.text,
          }));
          continue;
        }
        // 文本增量（同一 message item 累积）
        if (typeof part.text === "string" && part.text && part.thought !== true) {
          if (!activeText) {
            const item: Record<string, unknown> = {
              id: randomId("msg_"),
              type: "message",
              status: "in_progress",
              role: "assistant",
              content: [],
            };
            pending.push(item);
            const outputIndex = pending.indexOf(item);
            const partDelta: Record<string, unknown> = {
              id: randomId("part_"),
              type: "output_text",
              text: "",
              annotations: [],
            };
            (item.content as unknown[]).push(partDelta);
            activeText = { item, part: partDelta, outputIndex };
            frames.push(sse({
              type: "response.output_item.added",
              output_index: outputIndex,
              item: { ...item, content: [] },
            }));
            frames.push(sse({
              type: "response.content_part.added",
              item_id: item.id,
              output_index: outputIndex,
              content_index: 0,
              part: partDelta,
            }));
          }
          activeText.part.text = String(activeText.part.text ?? "") + part.text;
          frames.push(sse({
            type: "response.output_text.delta",
            item_id: activeText.item.id,
            output_index: activeText.outputIndex,
            content_index: 0,
            delta: part.text,
          }));
          continue;
        }
        // 函数调用（AI Studio 流式通常单帧完整；同 call_id 后续帧忽略）
        if (isRecord(part.functionCall)) {
          const call = part.functionCall;
          const callId = typeof call.id === "string" && call.id ? call.id : randomId("call_");
          if (emittedCallIds.has(callId)) continue;
          emittedCallIds.add(callId);
          rememberThoughtSignature(callId, part.thoughtSignature);
          const args = jsonArgs(call.args);
          const item: Record<string, unknown> = {
            id: randomId("fc_"),
            type: "function_call",
            status: "in_progress",
            call_id: callId,
            name: call.name,
            arguments: "",
          };
          pending.push(item);
          const outputIndex = pending.indexOf(item);
          frames.push(sse({ type: "response.output_item.added", output_index: outputIndex, item }));
          frames.push(sse({
            type: "response.function_call_arguments.delta",
            item_id: item.id,
            output_index: outputIndex,
            delta: args,
          }));
          frames.push(sse({
            type: "response.function_call_arguments.done",
            item_id: item.id,
            output_index: outputIndex,
            arguments: args,
          }));
          item.arguments = args;
          if (part.thoughtSignature) {
            item.extra_content = { google: { thought_signature: part.thoughtSignature } };
          }
          item.status = "completed";
          frames.push(sse({ type: "response.output_item.done", output_index: outputIndex, item }));
        }
      }
      return frames;
    },

    finish(finalResponse: unknown): string[] {
      if (finalized) return [];
      finalized = true;
      const frames = start();
      // 收尾：文本/推理 item 的 done 事件
      if (activeText) {
        const { item, part, outputIndex } = activeText;
        item.status = "completed";
        frames.push(sse({
          type: "response.output_text.done",
          item_id: item.id,
          output_index: outputIndex,
          content_index: 0,
          text: part.text,
        }));
        frames.push(sse({
          type: "response.content_part.done",
          item_id: item.id,
          output_index: outputIndex,
          content_index: 0,
          part,
        }));
        frames.push(sse({ type: "response.output_item.done", output_index: outputIndex, item }));
      }
      if (activeReasoning) {
        const { item, outputIndex } = activeReasoning;
        const summary = item.summary as unknown[];
        frames.push(sse({
          type: "response.reasoning_summary_text.done",
          item_id: item.id,
          output_index: outputIndex,
          summary_index: 0,
          text: summary.length > 0 && isRecord(summary[0]) ? String(summary[0].text ?? "") : "",
        }));
        item.status = "completed";
        frames.push(sse({ type: "response.output_item.done", output_index: outputIndex, item }));
      }
      rememberResponse(converted, pending, streamedParts);
      frames.push(sse({
        type: "response.completed",
        response: {
          ...responseHeader(converted, "completed"),
          output: pending,
          usage: usageOf(finalResponse) ?? {
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
            output_tokens_details: { reasoning_tokens: 0 },
          },
        },
      }));
      frames.push("data: [DONE]\n\n");
      return frames;
    },
  };
}
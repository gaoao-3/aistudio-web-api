/**
 * OpenAI Chat Completions <-> Gemini generateContent conversion layer.
 *
 * The gateway core speaks the Gemini protocol (normalizeGeminiRequest accepts
 * standard Gemini JSON), so this module only has to translate OpenAI chat
 * requests into Gemini bodies and translate Gemini responses back into
 * OpenAI chat.completion / chat.completion.chunk shapes.
 */

export class OpenAiRequestError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "OpenAiRequestError";
  }
}

export interface ConvertedChatRequest {
  readonly model: string;
  readonly geminiBody: Record<string, unknown>;
  readonly stream: boolean;
  readonly includeUsage: boolean;
}

const FINISH_REASON_MAP: Readonly<Record<string, string>> = {
  STOP: "stop",
  MAX_TOKENS: "length",
  FUNCTION_CALL: "tool_calls",
  SAFETY: "content_filter",
  RECITATION: "content_filter",
  LANGUAGE: "content_filter",
  PROHIBITED_CONTENT: "content_filter",
  SPII: "content_filter",
  OTHER: "content_filter",
};

/**
 * Gemini 思考模型要求函数调用带 thought signature；AI Studio 在响应里把
 * signature 放在 thinking part（wire 槽 14）。OpenAI 客户端（如 DSH/
 * pi-ai）收到 tool_calls 后不回传 extra_content 扩展字段，导致同一 turn
 * 内第二轮请求（assistant tool_calls 历史）丢 thought → 上游 400。
 * 这里按 call id 缓存响应侧透出的 signature，请求侧兜底回填，闭环不依赖
 * 客户端配合。
 */
const thoughtSignatureByCallId = new Map<string, string>();
const THOUGHT_SIGNATURE_CACHE_MAX = 4096;
function rememberThoughtSignature(callId: string | undefined, signature: unknown): void {
  if (!callId || typeof signature !== "string" || !signature) return;
  if (thoughtSignatureByCallId.size >= THOUGHT_SIGNATURE_CACHE_MAX) {
    const oldest = thoughtSignatureByCallId.keys().next().value;
    if (oldest !== undefined) thoughtSignatureByCallId.delete(oldest);
  }
  thoughtSignatureByCallId.set(callId, signature);
}
export { rememberThoughtSignature };
  
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string, code?: string): never {
  throw new OpenAiRequestError(400, message, code);
}

function chatCompletionId(): string {
  return `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/* ------------------------------------------------------------------ */
/* Request conversion                                                  */
/* ------------------------------------------------------------------ */

function convertImageUrl(url: string): Record<string, unknown> {
  const dataUri = /^data:([^;,]+);base64,([\s\S]+)$/u.exec(url);
  if (dataUri)
    return {
      inlineData: {
        mimeType: dataUri[1] ?? "image/png",
        data: dataUri[2] ?? "",
      },
    };
  if (url.startsWith("files/")) return { fileData: { fileUri: url } };
  fail(
    "image_url 仅支持 data: URI 或 Google Files URI（files/...），暂不支持远程 URL",
    "unsupported_image_url",
  );
}

function convertFilePart(
  file: Record<string, unknown>,
): Record<string, unknown> {
  const fileData =
    typeof file.file_data === "string" ? file.file_data : undefined;
  if (fileData) {
    const dataUri = /^data:([^;,]+);base64,([\s\S]+)$/u.exec(fileData);
    if (dataUri)
      return {
        inlineData: {
          mimeType: dataUri[1] ?? "application/octet-stream",
          data: dataUri[2] ?? "",
        },
      };
    if (fileData.startsWith("files/"))
      return { fileData: { fileUri: fileData } };
  }
  const fileId = typeof file.file_id === "string" ? file.file_id : undefined;
  if (fileId?.startsWith("files/")) return { fileData: { fileUri: fileId } };
  fail(
    "file 部件仅支持 data: URI 或 Google Files URI（files/...）",
    "unsupported_file_part",
  );
}

export function convertUserPart(part: unknown): Record<string, unknown> {
  if (typeof part === "string") return { text: part };
  if (!isRecord(part)) return fail("messages[].content[] 部件格式无效");
  if (
    part.type === undefined ||
    part.type === "text" ||
    part.type === "input_text"
  ) {
    return { text: typeof part.text === "string" ? part.text : "" };
  }
  if (part.type === "image_url") {
    const imageUrl = isRecord(part.image_url)
      ? part.image_url.url
      : part.image_url;
    if (typeof imageUrl !== "string" || !imageUrl)
      return fail("image_url.url 必须是非空字符串");
    return convertImageUrl(imageUrl);
  }
  if (part.type === "image") {
    const source = isRecord(part.source) ? part.source : {};
    if (typeof source.url === "string") return convertImageUrl(source.url);
    if (typeof source.data === "string")
      return convertImageUrl(
        `data:${source.media_type ?? "image/png"};base64,${source.data}`,
      );
    return fail("image 部件缺少 source.url 或 source.data");
  }
  if (part.type === "file") {
    if (!isRecord(part.file)) return fail("file 部件必须是对象");
    return convertFilePart(part.file);
  }
  return fail(
    `不支持的内容部件类型: ${String(part.type)}`,
    "unsupported_part_type",
  );
}

export function thoughtSignatureOf(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const direct =
    typeof value.thoughtSignature === "string" && value.thoughtSignature
      ? value.thoughtSignature
      : typeof value.thought_signature === "string" && value.thought_signature
        ? value.thought_signature
        : undefined;
  if (direct) return direct;
  for (const key of ["extra_content", "extraContent"] as const) {
    const extra = value[key];
    if (!isRecord(extra) || !isRecord(extra.google)) continue;
    const signature =
      typeof extra.google.thoughtSignature === "string" && extra.google.thoughtSignature
        ? extra.google.thoughtSignature
        : typeof extra.google.thought_signature === "string" && extra.google.thought_signature
          ? extra.google.thought_signature
          : undefined;
    if (signature) return signature;
  }
  return undefined;
}

function openAiToolCallMetadata(value: unknown): Record<string, unknown> {
  const signature = thoughtSignatureOf(value);
  return signature
    ? { extra_content: { google: { thought_signature: signature } } }
    : {};
}

function convertToolCall(
  call: unknown,
  index: number,
): { readonly id: string; readonly part: Record<string, unknown> } {
  if (!isRecord(call)) fail("messages[].tool_calls[] 必须是对象");
  const fn = isRecord(call.function) ? call.function : call;
  if (typeof fn.name !== "string" || !fn.name)
    fail("tool_calls[].function.name 必须是非空字符串");
  let args: unknown = {};
  if (typeof fn.arguments === "string") {
    try {
      args = fn.arguments ? JSON.parse(fn.arguments) : {};
    } catch {
      fail(`tool_calls[${index}].function.arguments 不是合法 JSON`);
    }
  } else if (fn.arguments !== undefined) {
    args = fn.arguments;
  } else if (fn.args !== undefined) {
    args = fn.args;
  }
  const id = typeof call.id === "string" && call.id ? call.id : `call_${index}`;
  // 客户端不回传 extra_content 时，用同 turn 内响应侧缓存的 signature 兜底回填。
  const cached = thoughtSignatureByCallId.get(id);
  const thoughtSignature =
    thoughtSignatureOf(call) ?? thoughtSignatureOf(fn) ?? cached;
  return {
    id,
    part: {
      functionCall: { name: fn.name, args, id },
      ...(thoughtSignature ? { thoughtSignature } : {}),
    },
  };
}

export function convertMessages(messages: unknown[]): {
  readonly contents: Record<string, unknown>[];
  readonly system: string[];
} {
  const contents: Record<string, unknown>[] = [];
  const system: string[] = [];
  const toolNameByCallId = new Map<string, string>();

  for (const [index, raw] of messages.entries()) {
    if (!isRecord(raw)) fail(`messages[${index}] 必须是对象`);
    const role = typeof raw.role === "string" ? raw.role : "user";
    const content = raw.content;

    if (role === "system" || role === "developer") {
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .map((item) =>
                  isRecord(item) && typeof item.text === "string"
                    ? item.text
                    : "",
                )
                .join("")
            : "";
      if (text) system.push(text);
      continue;
    }

    if (role === "tool") {
      const toolCallId =
        typeof raw.tool_call_id === "string" && raw.tool_call_id
          ? raw.tool_call_id
          : undefined;
      const name =
        typeof raw.name === "string" && raw.name
          ? raw.name
          : toolCallId
            ? toolNameByCallId.get(toolCallId)
            : undefined;
      if (!name)
        fail(
          `messages[${index}]（role=tool）无法确定函数名；请提供 name 字段或匹配的前置 assistant tool_call`,
        );
      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name,
              response: { result: content ?? "" },
              ...(toolCallId ? { id: toolCallId } : {}),
            },
          },
        ],
      });
      continue;
    }

    if (role === "user" || role === "assistant" || role === "model") {
      const parts: Record<string, unknown>[] = [];
      if (typeof content === "string") {
        if (content) parts.push({ text: content });
      } else if (Array.isArray(content)) {
        for (const part of content) parts.push(convertUserPart(part));
      } else if (content !== undefined && content !== null) {
        fail(`messages[${index}].content 必须是字符串或数组`);
      }
      if (Array.isArray(raw.tool_calls)) {
        raw.tool_calls.forEach((call, callIndex) => {
          const converted = convertToolCall(call, callIndex);
          toolNameByCallId.set(
            converted.id,
            (converted.part.functionCall as Record<string, unknown>)
              .name as string,
          );
          parts.push(converted.part);
        });
      }
      contents.push({
        role: role === "user" ? "user" : "model",
        parts: parts.length ? parts : [{ text: "" }],
      });
      continue;
    }

    fail(`不支持的消息角色: ${role}`, "unsupported_role");
  }

  return { contents, system };
}

export function convertTools(
  body: Record<string, unknown>,
): Record<string, unknown> | null {
  if (body.tools === undefined || body.tools === null) return null;
  if (!Array.isArray(body.tools)) fail("tools 必须是数组");
  const declarations: Record<string, unknown>[] = [];
  for (const tool of body.tools) {
    if (!isRecord(tool)) fail("tools[] 必须是对象");
    const fn =
      tool.type === "function" && isRecord(tool.function)
        ? tool.function
        : tool;
    if (typeof fn.name !== "string" || !fn.name)
      fail("tools[].function.name 必须是非空字符串");
    declarations.push({
      name: fn.name,
      ...(typeof fn.description === "string"
        ? { description: fn.description }
        : {}),
      ...(isRecord(fn.parameters) ? { parameters: fn.parameters } : {}),
    });
  }
  return declarations.length ? { functionDeclarations: declarations } : null;
}

export function convertToolChoice(
  body: Record<string, unknown>,
  hasTools: boolean,
): Record<string, unknown> | undefined {
  if (!hasTools || body.tool_choice === undefined || body.tool_choice === null)
    return undefined;
  const choice = body.tool_choice;
  if (choice === "auto") return undefined;
  if (choice === "none") return { mode: "NONE" };
  if (choice === "required" || choice === "any") return { mode: "ANY" };
  if (isRecord(choice)) {
    const fn = isRecord(choice.function) ? choice.function : choice;
    if (typeof fn.name === "string" && fn.name)
      return { mode: "ANY", allowedFunctionNames: [fn.name] };
  }
  fail(
    'tool_choice 仅支持 auto、none、required 或 {type:"function",function:{name}}',
  );
}

export function convertGenerationConfig(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  const numberField = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;

  const temperature = numberField(body.temperature);
  if (temperature !== undefined) config.temperature = temperature;
  const topP = numberField(body.top_p);
  if (topP !== undefined) config.topP = topP;
  const topK = numberField(body.top_k);
  if (topK !== undefined) config.topK = topK;
  const maxTokens =
    numberField(body.max_completion_tokens) ??
    numberField(body.max_tokens) ??
    numberField(body.max_output_tokens);
  if (maxTokens !== undefined) config.maxOutputTokens = Math.floor(maxTokens);

  const stop = body.stop ?? body.stop_sequences;
  if (typeof stop === "string") config.stopSequences = [stop];
  else if (Array.isArray(stop) && stop.length) {
    if (!stop.every((item) => typeof item === "string"))
      fail("stop 必须是字符串或字符串数组");
    config.stopSequences = stop;
  } else if (stop !== undefined) {
    fail("stop 必须是字符串或字符串数组");
  }

  const reasoning = body.reasoning_effort ?? body.reasoning;
  const effort =
    typeof reasoning === "string"
      ? reasoning
      : isRecord(reasoning)
        ? reasoning.effort
        : undefined;
  if (typeof effort === "string") {
    const level = effort.toUpperCase();
    if (["LOW", "MEDIUM", "HIGH", "MINIMAL"].includes(level))
      config.thinkingConfig = { thinkingLevel: level };
  }

  const format = body.response_format;
  if (format !== undefined) {
    if (!isRecord(format)) fail("response_format 必须是对象");
    if (format.type === "json_object") {
      config.responseMimeType = "application/json";
    } else if (format.type === "json_schema") {
      const schema = isRecord(format.json_schema)
        ? format.json_schema.schema
        : format.schema;
      if (!isRecord(schema))
        fail("response_format.json_schema.schema 必须是 JSON Schema 对象");
      config.responseSchema = schema;
    } else if (typeof format.type === "string") {
      fail(
        `不支持的 response_format.type: ${format.type}`,
        "unsupported_response_format",
      );
    }
  }
  return config;
}

export function convertChatRequest(body: unknown): ConvertedChatRequest {
  if (!isRecord(body)) fail("请求体必须是 JSON 对象");
  const model =
    typeof body.model === "string"
      ? body.model.trim().replace(/^models\//u, "")
      : "";
  if (!model) fail("缺少必填字段: model", "missing_model");
  if (model.includes(":"))
    fail("model 只能是模型 ID（例如 gemini-3-flash-preview）", "invalid_model");

  if (!Array.isArray(body.messages) || body.messages.length === 0)
    fail("messages 必须是非空数组", "missing_messages");
  const { contents, system } = convertMessages(body.messages);
  if (contents.length === 0)
    fail("messages 中至少需要一条 user/assistant/tool 消息", "empty_contents");

  let tools = convertTools(body);
  const toolConfig = convertToolChoice(body, tools !== null);
  if (toolConfig?.mode === "NONE") tools = null;

  const geminiBody: Record<string, unknown> = { contents };
  if (system.length)
    geminiBody.systemInstruction = {
      role: "user",
      parts: [{ text: system.join("\n\n") }],
    };
  if (tools) geminiBody.tools = [tools];
  if (toolConfig && toolConfig.mode !== "NONE")
    geminiBody.toolConfig = { functionCallingConfig: toolConfig };
  const generationConfig = convertGenerationConfig(body);
  if (Object.keys(generationConfig).length)
    geminiBody.generationConfig = generationConfig;

  return {
    model,
    geminiBody,
    stream: body.stream === true,
    includeUsage: isRecord(body.stream_options)
      ? body.stream_options.include_usage === true
      : false,
  };
}

/* ------------------------------------------------------------------ */
/* Response conversion (non-streaming)                                 */
/* ------------------------------------------------------------------ */

function candidateOf(response: unknown): Record<string, unknown> {
  if (
    !isRecord(response) ||
    !Array.isArray(response.candidates) ||
    !isRecord(response.candidates[0])
  ) {
    fail("上游返回了无效的 Gemini 响应（缺少 candidates）", "upstream_error");
  }
  return response.candidates[0];
}

function partsOf(
  candidate: Record<string, unknown>,
): Record<string, unknown>[] {
  const content = candidate.content;
  if (!isRecord(content) || !Array.isArray(content.parts)) return [];
  return content.parts.filter(isRecord);
}

function openAiFinishReason(geminiReason: unknown): string | null {
  if (typeof geminiReason !== "string") return null;
  return FINISH_REASON_MAP[geminiReason] ?? "stop";
}

function usageOf(response: unknown): Record<string, unknown> | undefined {
  if (!isRecord(response) || !isRecord(response.usageMetadata))
    return undefined;
  const meta = response.usageMetadata;
  const prompt =
    typeof meta.promptTokenCount === "number" ? meta.promptTokenCount : 0;
  const candidates =
    typeof meta.candidatesTokenCount === "number"
      ? meta.candidatesTokenCount
      : 0;
  const thoughts =
    typeof meta.thoughtsTokenCount === "number" ? meta.thoughtsTokenCount : 0;
  const total =
    typeof meta.totalTokenCount === "number" && meta.totalTokenCount > 0
      ? meta.totalTokenCount
      : prompt + candidates + thoughts;
  return {
    prompt_tokens: prompt,
    completion_tokens: candidates + thoughts,
    total_tokens: total,
  };
}

export function toChatCompletion(
  response: unknown,
  model: string,
): Record<string, unknown> {
  const candidate = candidateOf(response);
  const parts = partsOf(candidate);
  const text = parts
    .map((part) =>
      typeof part.text === "string" && part.thought !== true ? part.text : "",
    )
    .join("");
  const reasoning = parts
    .map((part) =>
      typeof part.text === "string" && part.thought === true ? part.text : "",
    )
    .join("");
  const toolCalls = parts.flatMap((part, index) => {
    if (!isRecord(part.functionCall)) return [];
    const call = part.functionCall;
    const id = typeof call.id === "string" && call.id ? call.id : `call_${index}`;
    rememberThoughtSignature(id, part.thoughtSignature);
    return [
      {
        id,
        type: "function",
        function: {
          name: call.name,
          arguments: JSON.stringify(call.args ?? {}),
        },
        ...openAiToolCallMetadata(part),
      },
    ];
  });

  const finishReason =
    openAiFinishReason(candidate.finishReason) ??
    (toolCalls.length ? "tool_calls" : "stop");

  return {
    id: chatCompletionId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text,
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        logprobs: null,
        finish_reason: finishReason,
      },
    ],
    usage: usageOf(response),
  };
}

/* ------------------------------------------------------------------ */
/* Response conversion (streaming)                                     */
/* ------------------------------------------------------------------ */

export interface ChatStreamEncoder {
  /** Convert one Gemini streaming chunk into OpenAI SSE frames. */
  feed(response: unknown): string[];
  /** Emit the terminal chunk (finish_reason + usage) followed by [DONE]. */
  finish(finalResponse: unknown): string[];
}

export function createChatStreamEncoder(
  model: string,
  includeUsage: boolean,
): ChatStreamEncoder {
  let sentRole = false;
  let toolCallCount = 0;
  let pendingFinish: string | null = null;
  let pendingUsage: Record<string, unknown> | undefined;

  const frame = (
    delta: Record<string, unknown>,
    finishReason: string | null,
    usage?: Record<string, unknown>,
  ): string => {
    const chunk: Record<string, unknown> = {
      id: chatCompletionId(),
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    if (usage) chunk.usage = usage;
    return `data: ${JSON.stringify(chunk)}\n\n`;
  };

  return {
    feed(response: unknown): string[] {
      if (!isRecord(response)) return [];
      const candidate =
        Array.isArray(response.candidates) && isRecord(response.candidates[0])
          ? response.candidates[0]
          : undefined;
      const parts = candidate ? partsOf(candidate) : [];
      const frames: string[] = [];

      if (!sentRole) {
        sentRole = true;
        frames.push(frame({ role: "assistant", content: "" }, null));
      }

      const text = parts
        .map((part) =>
          typeof part.text === "string" && part.thought !== true
            ? part.text
            : "",
        )
        .join("");
      if (text) frames.push(frame({ content: text }, null));
      const reasoning = parts
        .map((part) =>
          typeof part.text === "string" && part.thought === true
            ? part.text
            : "",
        )
        .join("");
      if (reasoning) frames.push(frame({ reasoning_content: reasoning }, null));

      for (const part of parts) {
        if (!isRecord(part.functionCall)) continue;
        const call = part.functionCall;
        const callId =
          typeof call.id === "string" && call.id ? call.id : `call_${toolCallCount}`;
        rememberThoughtSignature(callId, part.thoughtSignature);
        frames.push(
          frame(
            {
              tool_calls: [
                {
                  index: toolCallCount,
                  id: callId,
                  type: "function",
                  function: {
                    name: call.name,
                    arguments: JSON.stringify(call.args ?? {}),
                  },
                  ...openAiToolCallMetadata(part),
                },
              ],
            },
            null,
          ),
        );
        toolCallCount += 1;
      }

      if (candidate && candidate.finishReason !== undefined) {
        pendingFinish =
          openAiFinishReason(candidate.finishReason) ?? pendingFinish;
      }
      const usage = usageOf(response);
      if (
        usage &&
        (usage.completion_tokens as number) + (usage.prompt_tokens as number) >
          0
      )
        pendingUsage = usage;

      return frames;
    },

    finish(finalResponse: unknown): string[] {
      const frames: string[] = [];
      if (!sentRole) {
        sentRole = true;
        frames.push(frame({ role: "assistant", content: "" }, null));
      }
      let finishReason = pendingFinish;
      if (!finishReason && isRecord(finalResponse)) {
        const candidate =
          Array.isArray(finalResponse.candidates) &&
          isRecord(finalResponse.candidates[0])
            ? finalResponse.candidates[0]
            : undefined;
        finishReason = candidate
          ? openAiFinishReason(candidate.finishReason)
          : null;
        if (
          !finishReason &&
          candidate &&
          partsOf(candidate).some((part) => isRecord(part.functionCall))
        )
          finishReason = "tool_calls";
      }
      const usage = usageOf(finalResponse) ?? pendingUsage;
      frames.push(
        frame({}, finishReason ?? "stop", includeUsage ? usage : undefined),
      );
      frames.push("data: [DONE]\n\n");
      return frames;
    },
  };
}

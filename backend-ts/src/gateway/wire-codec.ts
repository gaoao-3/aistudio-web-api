export interface AistudioPart {
  readonly text?: string | null;
  readonly inlineData?: readonly [string, string];
  readonly fileId?: string;
  readonly functionCall?: readonly [string, unknown, string?];
  readonly functionResponse?: readonly [string, unknown, string?];
  readonly thoughtSignature?: string;
  readonly thought?: boolean;
}

export interface AistudioContent {
  readonly role: string;
  readonly parts: readonly AistudioPart[];
}

export interface RewriteWireOptions {
  readonly model: string;
  readonly snapshot?: string;
  readonly prompt?: string;
  readonly contents?: readonly AistudioContent[];
  readonly systemInstruction?: AistudioContent | string | null;
  readonly tools?: unknown[][] | null;
  readonly safetySettings?: unknown[][] | null;
  readonly temperature?: number;
  readonly topP?: number;
  readonly topK?: number;
  readonly maxTokens?: number;
  readonly generationConfig?: Readonly<Record<string, unknown>>;
  readonly sanitizePlainText?: boolean;
  readonly safetyOff?: boolean;
  readonly disableThinking?: boolean;
  /** Private AI Studio outer continuation ID; null explicitly clears the captured value. */
  readonly previousResponseId?: string | null;
  /** Account runtime timezone captured from the page; falls back to Asia/Shanghai. */
  readonly timezone?: string;
}

const INDEX = {
  model: 0,
  contents: 1,
  safety: 2,
  generation: 3,
  snapshot: 4,
  system: 5,
  tools: 6,
  requestFlag: 10,
  previousResponseId: 11,
  timezone: 13,
} as const;

const GENERATION_INDEX: Readonly<Record<string, number>> = {
  stopSequences: 1,
  maxOutputTokens: 3,
  maxTokens: 3,
  temperature: 4,
  topP: 5,
  topK: 6,
  responseMimeType: 7,
  responseSchema: 8,
  presencePenalty: 9,
  frequencyPenalty: 10,
  responseLogprobs: 11,
  logprobs: 12,
  imageOutputMode: 14,
  thinkingConfig: 16,
  mediaResolution: 17,
  seed: 18,
  outputResolution: 26,
} as const;

const SAFETY_OFF_SETTINGS = Object.freeze([7, 8, 9, 10].map(category => Object.freeze([null, null, category, 5])));

export const TOOL_TEMPLATES = {
  code_execution: [[]],
  google_search: [null, null, null, [null, [[]]]],
  google_maps: [null, null, null, null, null, null, null, null, null, null, []],
  url_context: [null, null, null, null, null, null, null, []],
} as const;

function ensureLength(values: unknown[], size: number): void {
  while (values.length < size) values.push(null);
}

function wireArgs(value: Record<string, unknown>): unknown[] {
  return [Object.entries(value).map(([key, item]) => [key, wireArgumentValue(item)])];
}

function wireArgumentValue(value: unknown): unknown[] {
  // FunctionCall.args is a google.protobuf.Struct. Its nested values use
  // the same Value oneof layout as FunctionResponse.response, including
  // list_value at slot 6 and struct_value at slot 5.
  return wireStructValue(value);
}

// google.protobuf.Struct encoding in JSPB positional form: pairs of
// [key, Value] where Value is the oneof kind (1=null, 2=number, 3=string,
// 4=bool, 5=struct, 6=list) placed at its field index.
function wireStructPairs(value: Record<string, unknown>): unknown[] {
  return Object.entries(value).map(([key, item]) => [key, wireStructValue(item)]);
}

function wireStructValue(value: unknown): unknown[] {
  if (value === null || value === undefined) return [0];
  if (typeof value === "number") return [null, value];
  if (typeof value === "string") return [null, null, value];
  if (typeof value === "boolean") return [null, null, null, value];
  if (Array.isArray(value)) return [null, null, null, null, null, [value.map(wireStructValue)]];
  if (isRecord(value)) return [null, null, null, null, [wireStructPairs(value)]];
  return [null, null, String(value)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function encodePart(part: AistudioPart): unknown[] {
  if (part.fileId) return [null, null, null, null, null, [part.fileId]];
  if (part.inlineData) {
    const result: unknown[] = [null, null, [...part.inlineData]];
    if (part.thoughtSignature) {
      ensureLength(result, 15);
      result[14] = part.thoughtSignature;
    }
    return result;
  }
  if (part.functionCall) {
    const [name, args, callId] = part.functionCall;
    const encodedArgs = isRecord(args) ? wireArgs(args) : args;
    const call: unknown[] = [name, encodedArgs];
    if (callId) call.push(callId);
    const result: unknown[] = Array.from({ length: 11 }, () => null);
    result[10] = call;
    if (part.thoughtSignature) {
      ensureLength(result, 15);
      result[14] = part.thoughtSignature;
    }
    return result;
  }
  if (part.functionResponse) {
    const [name, response, callId] = part.functionResponse;
    // The response payload is a google.protobuf.Struct in JSPB positional
    // form: an entries array wrapped in a message array. The live RPC
    // accepts this shape before applying its account-level permission checks.
    // Match AI Studio's manual editor for scalar function results.
    const responseStruct = isRecord(response) ? response : { response };
    const functionResponse: unknown[] = [name, [wireStructPairs(responseStruct)]];
    if (callId) functionResponse.push(callId);
    const result: unknown[] = Array.from({ length: 12 }, () => null);
    result[11] = functionResponse;
    return result;
  }
  const result: unknown[] = [null, part.text ?? null];
  if (part.thought) {
    ensureLength(result, 13);
    result[12] = 1;
  }
  if (part.thoughtSignature) {
    ensureLength(result, 15);
    result[14] = part.thoughtSignature;
  }
  return result;
}

export function encodeContent(content: AistudioContent): unknown[] {
  return [content.parts.map(encodePart), content.role];
}

export function decodePart(raw: unknown): AistudioPart {
  if (!Array.isArray(raw)) return {};
  if (Array.isArray(raw[5]) && typeof raw[5][0] === "string") return { fileId: raw[5][0] };
  if (Array.isArray(raw[2]) && typeof raw[2][0] === "string" && typeof raw[2][1] === "string") {
    return { inlineData: [raw[2][0], raw[2][1]], ...(typeof raw[14] === "string" ? { thoughtSignature: raw[14] } : {}) };
  }
  const call = Array.isArray(raw[10]) ? raw[10] : Array.isArray(raw[3]) ? raw[3] : undefined;
  if (call) {
    const name = typeof call[0] === "string" ? call[0] : "unknown";
    const args = call[1] ?? {};
    const callId = typeof call[2] === "string" ? call[2] : undefined;
    return {
      functionCall: callId ? [name, args, callId] : [name, args],
      ...(typeof raw[14] === "string" ? { thoughtSignature: raw[14] } : {}),
    };
  }
  const response = Array.isArray(raw[11]) ? raw[11] : Array.isArray(raw[4]) ? raw[4] : undefined;
  if (response) {
    const name = typeof response[0] === "string" ? response[0] : "unknown";
    const value = response[1] ?? {};
    const callId = typeof response[2] === "string" ? response[2] : undefined;
    return { functionResponse: callId ? [name, value, callId] : [name, value] };
  }
  return {
    ...(raw[1] === null || typeof raw[1] === "string" ? { text: raw[1] as string | null } : {}),
    ...(raw[12] === 1 ? { thought: true } : {}),
    ...(typeof raw[14] === "string" ? { thoughtSignature: raw[14] } : {}),
  };
}

export function decodeContents(raw: unknown): AistudioContent[] {
  if (!Array.isArray(raw)) return [];
  const result: AistudioContent[] = [];
  for (const item of raw) {
    if (!Array.isArray(item) || !Array.isArray(item[0]) || typeof item[1] !== "string") continue;
    result.push({ role: item[1], parts: item[0].map(decodePart) });
  }
  return result;
}

function setGenerationValue(values: unknown[], name: string, value: unknown): void {
  const index = GENERATION_INDEX[name];
  if (index === undefined) return;
  ensureLength(values, index + 1);
  values[index] = value;
}

export function rewriteWireBody(originalBody: string, options: RewriteWireOptions): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(originalBody);
  } catch {
    throw new Error("捕获的 AI Studio 请求模板不是合法 JSON（可能捕获到了错误上报请求），请重试以触发重新捕获");
  }
  if (!Array.isArray(parsed)) throw new Error("Captured AI Studio request body must be an array");
  const body = structuredClone(parsed) as unknown[];
  ensureLength(body, INDEX.timezone + 1);
  const model = options.model.startsWith("models/") ? options.model : `models/${options.model}`;
  const normalizedModel = model.slice("models/".length).toLowerCase();
  const isImage = normalizedModel.includes("image");
  const isTts = normalizedModel.includes("tts");
  body[INDEX.model] = model;
  if (options.contents) body[INDEX.contents] = options.contents.map(encodeContent);
  else if (options.prompt !== undefined) body[INDEX.contents] = [encodeContent({ role: "user", parts: [{ text: options.prompt }] })];
  if (options.snapshot !== undefined) body[INDEX.snapshot] = options.snapshot;
  if (options.systemInstruction !== undefined) {
    body[INDEX.system] = typeof options.systemInstruction === "string"
      ? encodeContent({ role: "user", parts: [{ text: options.systemInstruction }] })
      : options.systemInstruction ? encodeContent(options.systemInstruction) : null;
  } else {
    body[INDEX.system] = null;
  }

  const generation = Array.isArray(body[INDEX.generation]) ? body[INDEX.generation] as unknown[] : [];
  body[INDEX.generation] = generation;
  if (options.maxTokens !== undefined) setGenerationValue(generation, "maxOutputTokens", options.maxTokens);
  if (options.temperature !== undefined) setGenerationValue(generation, "temperature", options.temperature);
  if (options.topP !== undefined) setGenerationValue(generation, "topP", options.topP);
  if (options.topK !== undefined) setGenerationValue(generation, "topK", options.topK);
  for (const [name, value] of Object.entries(options.generationConfig ?? {})) {
    if (value !== undefined && value !== null) setGenerationValue(generation, name, value);
  }

  if (!isTts && !options.disableThinking) {
    if ((options.sanitizePlainText ?? true) && !isImage) {
      setGenerationValue(generation, "responseMimeType", "text/plain");
      setGenerationValue(generation, "responseSchema", null);
      setGenerationValue(generation, "thinkingConfig", null);
    }
    if (generation[16] == null) setGenerationValue(generation, "thinkingConfig", [1, null, null, isImage ? 4 : 3]);
  } else {
    for (const index of [7, 8, 14, 16]) if (index < generation.length) generation[index] = null;
  }
  if (isImage) {
    if (generation[14] == null) setGenerationValue(generation, "imageOutputMode", [2]);
    for (const index of [7, 13, 17]) if (index < generation.length) generation[index] = null;
    if (options.disableThinking) setGenerationValue(generation, "thinkingConfig", null);
    body[INDEX.safety] = null;
  } else if (options.safetySettings !== undefined) {
    body[INDEX.safety] = options.safetySettings;
  } else if (!isTts) {
    // Default to the loosest threshold (5 = OFF) for every text model unless
    // the request explicitly provides safetySettings. AI Studio's pre-submit
    // moderation is separate and cannot be disabled through this field.
    body[INDEX.safety] = SAFETY_OFF_SETTINGS;
  }
  const tools = options.tools ?? null;
  body[INDEX.tools] = tools;
  if (!isImage) {
    if (tools?.length) {
      body[INDEX.timezone] = body[INDEX.timezone] ?? [[null, null, options.timezone ?? "Asia/Shanghai"]];
      setGenerationValue(generation, "responseMimeType", null);
      setGenerationValue(generation, "responseSchema", null);
    } else {
      body.length = Math.min(body.length, 11);
    }
  }
  // AIStudio2API 的现场证据：field 11（索引 10）固定为 1；但真实页面携带
  // previousResponseId 的续接请求中该槽为 null，故仅在非续接请求时补 1。
  if (options.previousResponseId === undefined && body[INDEX.requestFlag] == null) {
    body[INDEX.requestFlag] = 1;
  }
  if (options.previousResponseId !== undefined) body[INDEX.previousResponseId] = options.previousResponseId;
  return JSON.stringify(body);
}

export function buildToolsFromNames(names: readonly string[], model: string): unknown[][] {
  const normalized = model.replace(/^models\//u, "").toLowerCase();
  const isImage = normalized.includes("image");
  if (isImage) {
    let google = false;
    let image = false;
    for (const raw of names) {
      const name = raw.trim().toLowerCase();
      if (["google_search_and_image_search", "image_google_search_and_image_search"].includes(name)) google = image = true;
      else if (["google_search", "image_google_search"].includes(name)) google = true;
      else if (["image_search", "google_image_search"].includes(name)) image = true;
      else throw new Error(`Tool ${raw} is not allowed for model ${model}`);
    }
    if (!google && !image) return [];
    return [[null, null, null, [null, google && image ? [[], []] : google ? [[]] : [null, []]]]];
  }
  const allowed = normalized.startsWith("gemini-")
    ? new Set(["google_search", "code_execution", "google_maps", "url_context"])
    : new Set(["google_search", "code_execution"]);
  return names.map(raw => {
    const name = raw.trim().toLowerCase() as keyof typeof TOOL_TEMPLATES;
    if (!allowed.has(name) || !(name in TOOL_TEMPLATES)) throw new Error(`Tool ${raw} is not allowed for model ${model}`);
    // SAFETY: the allowlist above narrows name to a known wire-template key; every template is an array payload.
    return structuredClone(TOOL_TEMPLATES[name]) as unknown as unknown[];
  });
}

export interface CountTokensWireOptions {
  readonly model: string;
  readonly contents: readonly AistudioContent[];
  readonly systemInstruction?: AistudioContent | string | null;
  readonly tools?: unknown[][] | null;
}

/**
 * CountTokens 请求体（现场确认的形状）：纯文本 contents 用 [model, contents]；
 * 含 system、tools 或 function/media part 时用 [model, null, generate]，
 * generate 中 contents 位于索引 1、system 位于 5、tools 位于 6。
 */
export function encodeCountTokensBody(options: CountTokensWireOptions): string {
  const model = options.model.startsWith("models/") ? options.model : `models/${options.model}`;
  const contents = options.contents.map(encodeContent);
  if (contents.length === 0 && !options.systemInstruction) throw new Error("CountTokens contents 不能为空");
  const system = options.systemInstruction === undefined || options.systemInstruction === null
    ? null
    : typeof options.systemInstruction === "string"
      ? encodeContent({ role: "user", parts: [{ text: options.systemInstruction }] })
      : encodeContent(options.systemInstruction);
  const tools = options.tools ?? null;
  const hasSpecialPart = options.contents.some(content => content.parts.some(part =>
    part.inlineData !== undefined || part.fileId !== undefined
    || part.functionCall !== undefined || part.functionResponse !== undefined));
  if (!system && !tools && !hasSpecialPart) return JSON.stringify([model, contents]);
  const generate: unknown[] = [model, contents, null, null, null, system, tools];
  while (generate.length > 2 && generate[generate.length - 1] === null) generate.pop();
  return JSON.stringify([model, null, generate]);
}

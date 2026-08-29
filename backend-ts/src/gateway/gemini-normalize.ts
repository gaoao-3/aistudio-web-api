import { HttpError } from "../http/errors.js";
import { buildToolsFromNames, type AistudioContent, type AistudioPart } from "./wire-codec.js";

const SCHEMA_TYPES: Readonly<Record<string, number>> = {
  string: 1,
  number: 2,
  integer: 3,
  boolean: 4,
  array: 5,
  object: 6,
};

const SAFETY_CATEGORIES: Readonly<Record<string, number>> = {
  HARM_CATEGORY_HARASSMENT: 7,
  HARM_CATEGORY_HATE_SPEECH: 8,
  HARM_CATEGORY_SEXUALLY_EXPLICIT: 9,
  HARM_CATEGORY_DANGEROUS_CONTENT: 10,
};

const SAFETY_THRESHOLDS: Readonly<Record<string, number>> = {
  BLOCK_LOW_AND_ABOVE: 1,
  BLOCK_MEDIUM_AND_ABOVE: 2,
  BLOCK_ONLY_HIGH: 3,
  BLOCK_NONE: 4,
  OFF: 5,
};

export interface NormalizedGeminiRequest {
  readonly model: string;
  readonly contents: AistudioContent[];
  readonly systemInstruction: AistudioContent | null;
  readonly tools: unknown[][] | null;
  readonly includeServerSideToolInvocations: boolean;
  readonly safetySettings: unknown[][] | null;
  readonly generationConfig: Record<string, unknown>;
  readonly capturePrompt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeFileData(value: Record<string, unknown>): AistudioPart {
  const rawUri = value.fileUri ?? value.file_uri;
  if (typeof rawUri !== "string" || !rawUri.trim()) throw new Error("fileData.fileUri is required");
  const uri = rawUri.trim();
  const dataUri = /^data:([^;,]+);base64,([\s\S]+)$/u.exec(uri);
  if (dataUri) return { inlineData: [dataUri[1] ?? "application/octet-stream", dataUri[2] ?? ""] };

  if (uri.startsWith("files/")) return { fileId: uri.slice("files/".length) };
  try {
    const parsed = new URL(uri);
    const match = /\/(files\/[^/?#]+)\/?$/u.exec(parsed.pathname);
    if (match?.[1]) return { fileId: decodeURIComponent(match[1].slice("files/".length)) };
  } catch {
    // The validation below provides the public error for malformed URIs.
  }
  throw new Error("fileData.fileUri must be a Google Files URI or data URI");
}

function concreteSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(schema.type)) {
    const type = schema.type.find(item => item !== "null");
    if (type) return { ...schema, type: String(type).toLowerCase() };
  }
  if (typeof schema.type === "string") return { ...schema, type: schema.type.toLowerCase() };
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    if (!Array.isArray(schema[key])) continue;
    for (const item of schema[key]) {
      if (!isRecord(item)) continue;
      const candidate = concreteSchema(item);
      if (candidate.type || candidate.properties) return { ...schema, ...candidate };
    }
  }
  if (isRecord(schema.properties) || "additionalProperties" in schema) return { ...schema, type: "object" };
  return schema;
}

export function encodeSchemaToWire(input: Record<string, unknown>, includeRequired = true): unknown[] {
  const schema = concreteSchema(input);
  const type = typeof schema.type === "string" ? schema.type : "";
  const wire: unknown[] = [SCHEMA_TYPES[type] ?? 0];
  if (type === "array" && isRecord(schema.items)) {
    while (wire.length <= 5) wire.push(null);
    wire[5] = encodeSchemaToWire(schema.items, includeRequired);
  }
  if (isRecord(schema.properties)) {
    while (wire.length <= 6) wire.push(null);
    wire[6] = Object.entries(schema.properties)
      .filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1]))
      .map(([name, value]) => [name, encodeSchemaToWire(value, includeRequired)]);
  }
  if (Array.isArray(schema.required)) {
    if (includeRequired) {
      while (wire.length <= 7) wire.push(null);
      wire[7] = schema.required;
    } else {
      // AI Studio's Function declarations editor stores required property names
      // in the schema ordering slot rather than the regular required slot.
      while (wire.length <= 22) wire.push(null);
      wire[22] = schema.required;
    }
  }
  if (Array.isArray(schema.propertyOrdering)) {
    while (wire.length <= 22) wire.push(null);
    wire[22] = schema.propertyOrdering;
  }
  return wire;
}

function encodeFunctionDeclaration(declaration: Record<string, unknown>): unknown[] {
  if (typeof declaration.name !== "string" || !declaration.name) throw new Error("functionDeclarations[].name is required");
  const wire: unknown[] = [declaration.name];
  if (declaration.description !== undefined) wire.push(declaration.description);
  const parameters = isRecord(declaration.parameters) ? declaration.parameters
    : isRecord(declaration.parametersJsonSchema) ? declaration.parametersJsonSchema : undefined;
  if (parameters) {
    while (wire.length <= 2) wire.push(null);
    wire[2] = encodeSchemaToWire(parameters, false);
  }
  return wire;
}

function normalizePart(value: unknown): AistudioPart | undefined {
  if (!isRecord(value)) return undefined;
  const signature = typeof value.thoughtSignature === "string" ? value.thoughtSignature : undefined;
  if (value.text !== undefined) return {
    text: String(value.text),
    ...(value.thought === true ? { thought: true } : {}),
    ...(signature ? { thoughtSignature: signature } : {}),
  };
  if (isRecord(value.inlineData) && typeof value.inlineData.mimeType === "string" && typeof value.inlineData.data === "string") {
    return { inlineData: [value.inlineData.mimeType, value.inlineData.data], ...(signature ? { thoughtSignature: signature } : {}) };
  }
  if (isRecord(value.functionCall)) {
    if (typeof value.functionCall.name !== "string" || !value.functionCall.name) throw new Error("functionCall.name is required");
    const callId = typeof value.functionCall.id === "string" ? value.functionCall.id : undefined;
    return {
      functionCall: callId
        ? [value.functionCall.name, value.functionCall.args ?? {}, callId]
        : [value.functionCall.name, value.functionCall.args ?? {}],
      ...(signature ? { thoughtSignature: signature } : {}),
    };
  }
  if (isRecord(value.functionResponse)) {
    if (typeof value.functionResponse.name !== "string" || !value.functionResponse.name) throw new Error("functionResponse.name is required");
    const rawResponse = value.functionResponse.response;
    // AI Studio's manual response editor wraps a scalar under the `response` key.
    const response = isRecord(rawResponse) ? rawResponse : { response: rawResponse };
    const callId = typeof value.functionResponse.id === "string" ? value.functionResponse.id : undefined;
    return { functionResponse: callId ? [value.functionResponse.name, response, callId] : [value.functionResponse.name, response] };
  }
  if (isRecord(value.fileData)) return normalizeFileData(value.fileData);
  if (value.fileData !== undefined) throw new Error("fileData must be an object");
  return undefined;
}

function normalizeContent(value: unknown, defaultRole: string): AistudioContent {
  if (!isRecord(value) || !Array.isArray(value.parts)) throw new Error("contents[].parts must be an array");
  const role = typeof value.role === "string" ? value.role : defaultRole;
  const parts = value.parts.map(normalizePart).filter((part): part is AistudioPart => Boolean(part));
  const textIndexes = parts.flatMap((part, index) => part.text !== undefined ? [index] : []);
  if (role === "model" && textIndexes.length >= 2) {
    const last = textIndexes.at(-1);
    for (const index of textIndexes) {
      if (index === last || parts[index]?.thought) continue;
      parts[index] = { ...parts[index], thought: true };
    }
  }
  return { role, parts };
}

function normalizeSafety(value: unknown): unknown[][] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) throw new Error("safetySettings must be an array");
  const settings = value.flatMap(item => {
    if (!isRecord(item) || typeof item.category !== "string" || typeof item.threshold !== "string") {
      throw new Error("Invalid safetySettings entry");
    }
    const category = SAFETY_CATEGORIES[item.category.toUpperCase()];
    const threshold = SAFETY_THRESHOLDS[item.threshold.toUpperCase()];
    // AI Studio 浏览器会话只支持上表四类五档；其余类别（如 CIVIC_INTEGRITY）直接忽略而不是报错
    if (!category || !threshold) return [];
    return [[null, null, category, threshold]];
  });
  return settings.length ? settings : null;
}

type NormalizedThinkingConfig = readonly [number, null, null, number] | readonly unknown[] | string | number | boolean | null;

function normalizeThinking(value: unknown): NormalizedThinkingConfig {
  if (Array.isArray(value)) return value;
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (!isRecord(value)) throw new Error("thinkingConfig must be a JSON value or an object");
  const levels: Readonly<Record<string, number>> = { LOW: 1, MEDIUM: 2, HIGH: 3, MINIMAL: 4 };
  const raw = value.thinkingLevel ?? value.level ?? "HIGH";
  const level = typeof raw === "number" ? raw : levels[String(raw).toUpperCase()];
  if (!level) throw new Error(`Unsupported thinking level: ${String(raw)}`);
  return [Number(value.mode ?? 1), null, null, level];
}

export function normalizeGeminiRequest(modelPath: string, body: unknown): NormalizedGeminiRequest {
  if (!isRecord(body)) throw new Error("contents is required");
  if (body.cachedContent !== undefined) {
    throw new HttpError(400, {
      message: "cachedContent is not supported by the AI Studio browser-session gateway; use the official Gemini API for Context Cache",
      type: "invalid_request_error",
    });
  }
  if (!Array.isArray(body.contents) || body.contents.length === 0) throw new Error("contents is required");
  const model = modelPath.startsWith("models/") ? modelPath : `models/${modelPath}`;
  const contents = body.contents.map(item => normalizeContent(item, "user"));
  let capturePrompt = "你好";
  for (const content of contents) {
    if (content.role !== "user") continue;
    const text = content.parts.flatMap(part => typeof part.text === "string" ? [part.text] : []);
    if (text.length > 0) capturePrompt = text.join("\n");
  }
  const isTts = model.toLowerCase().includes("tts");
  const systemInstruction = !isTts && body.systemInstruction !== undefined
    ? normalizeContent(body.systemInstruction, "user") : null;

  let tools: unknown[][] | null = null;
  let hasBuiltinTools = false;
  let hasFunctionTools = false;
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) throw new Error("tools must be an array");
    tools = [];
    for (const rawTool of body.tools) {
      if (!isRecord(rawTool)) throw new Error("tools[] must be an object");
      const names: string[] = [];
      if (rawTool.codeExecution !== undefined) names.push("code_execution");
      if (rawTool.googleSearch !== undefined || rawTool.googleSearchRetrieval !== undefined) names.push("google_search");
      if (rawTool.googleMaps !== undefined) names.push("google_maps");
      if (rawTool.urlContext !== undefined) names.push("url_context");
      if (Array.isArray(rawTool.functionDeclarations)) {
        hasFunctionTools = rawTool.functionDeclarations.length > 0 || hasFunctionTools;
        tools.push([null, rawTool.functionDeclarations.map(item => {
          if (!isRecord(item)) throw new Error("functionDeclarations[] must be an object");
          return encodeFunctionDeclaration(item);
        })]);
      }
      if (names.length > 0) {
        hasBuiltinTools = true;
        tools.push(...buildToolsFromNames(names, model));
      }
    }
  }
  if (isTts) tools = null;

  const rawGeneration = isRecord(body.generationConfig) ? body.generationConfig : {};
  const rawToolConfig = isRecord(body.toolConfig) ? body.toolConfig : {};
  const includeServerSideToolInvocations = rawToolConfig.includeServerSideToolInvocations === true
    || (model.slice("models/".length).toLowerCase().startsWith("gemini-3") && hasBuiltinTools && hasFunctionTools);
  const generationConfig: Record<string, unknown> = { ...rawGeneration };
  if (rawGeneration.thinkingConfig !== undefined) generationConfig.thinkingConfig = normalizeThinking(rawGeneration.thinkingConfig);
  if (isRecord(rawGeneration.responseSchema)) {
    // 结构化输出 schema 必须转为 wire 位置编码；required 走常规槽位（与函数声明不同）。
    generationConfig.responseSchema = encodeSchemaToWire(rawGeneration.responseSchema, true);
    if (generationConfig.responseMimeType === undefined) generationConfig.responseMimeType = "application/json";
  }
  if (Array.isArray(rawGeneration.responseModalities)) {
    const modalities = new Set(rawGeneration.responseModalities.map(item => String(item).toUpperCase()));
    if (modalities.has("IMAGE")) generationConfig.imageOutputMode = modalities.has("TEXT") ? [2, 1] : [2];
  }
  if (isRecord(rawGeneration.imageConfig)) {
    generationConfig.outputResolution = [rawGeneration.imageConfig.aspectRatio ?? null, rawGeneration.imageConfig.imageSize ?? null];
  }
  return {
    model,
    contents,
    systemInstruction,
    tools,
    includeServerSideToolInvocations,
    safetySettings: normalizeSafety(body.safetySettings),
    generationConfig,
    capturePrompt,
  };
}

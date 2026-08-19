import type {
  FunctionCallStep,
  FunctionResultStep,
  BuiltinToolName,
  InteractionTool,
  InteractionContent,
  InteractionCreateRequest,
  InteractionStep,
  JsonValue,
  ModelOutputStep,
  ThoughtStep,
  UserInputStep,
} from "./types.js";

const BUILTIN_TOOL_TYPES = new Set<BuiltinToolName>(["google_search", "code_execution", "google_maps", "url_context"]);

export class InteractionValidationError extends TypeError {
  constructor(readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "InteractionValidationError";
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InteractionValidationError(path, "expected an object");
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string") throw new InteractionValidationError(path, "expected a string");
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return stringValue(value, path);
}

function jsonValue(value: unknown, path: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => jsonValue(item, `${path}[${index}]`));
  }
  const source = record(value, path);
  return Object.fromEntries(Object.entries(source).map(([key, item]) => [key, jsonValue(item, `${path}.${key}`)]));
}

function jsonObject(value: unknown, path: string): Record<string, JsonValue> {
  const source = record(value, path);
  return Object.fromEntries(Object.entries(source).map(([key, item]) => [key, jsonValue(item, `${path}.${key}`)]));
}

const CONTENT_TYPES = new Set(["text", "image", "audio", "document"]);
const STEP_TYPES = new Set(["user_input", "thought", "model_output", "function_call", "function_result"]);

export function parseInteractionContent(value: unknown, path = "content"): InteractionContent {
  const source = record(value, path);
  const type = stringValue(source.type, `${path}.type`);
  if (!CONTENT_TYPES.has(type)) throw new InteractionValidationError(`${path}.type`, `unsupported content type ${type}`);
  if (type === "text") {
    return { type, text: stringValue(source.text, `${path}.text`) };
  }
  const data = optionalString(source.data, `${path}.data`);
  const uri = optionalString(source.uri, `${path}.uri`);
  const mime_type = optionalString(source.mime_type, `${path}.mime_type`);
  return {
    type,
    ...(data !== undefined ? { data } : {}),
    ...(uri !== undefined ? { uri } : {}),
    ...(mime_type !== undefined ? { mime_type } : {}),
  } as InteractionContent;
}

function contentArray(value: unknown, path: string): InteractionContent[] {
  if (!Array.isArray(value)) throw new InteractionValidationError(path, "expected an array");
  return value.map((item, index) => parseInteractionContent(item, `${path}[${index}]`));
}

function parseUserInput(source: Record<string, unknown>, path: string): UserInputStep {
  const status = optionalString(source.status, `${path}.status`);
  if (status !== undefined && status !== "done" && status !== "in_progress") {
    throw new InteractionValidationError(`${path}.status`, "must be done or in_progress");
  }
  const content = contentArray(source.content, `${path}.content`);
  return status === undefined
    ? { type: "user_input", content }
    : { type: "user_input", content, status: status as NonNullable<UserInputStep["status"]> };
}

function parseModelOutput(source: Record<string, unknown>, path: string): ModelOutputStep {
  const status = optionalString(source.status, `${path}.status`);
  if (status !== undefined && status !== "done" && status !== "in_progress") {
    throw new InteractionValidationError(`${path}.status`, "must be done or in_progress");
  }
  const content = contentArray(source.content, `${path}.content`);
  return status === undefined
    ? { type: "model_output", content }
    : { type: "model_output", content, status: status as NonNullable<ModelOutputStep["status"]> };
}

function parseThought(source: Record<string, unknown>, path: string): ThoughtStep {
  const summaryValue = source.summary;
  const summary = summaryValue === undefined
    ? undefined
    : contentArray(summaryValue, `${path}.summary`).map((item, index) => {
      if (item.type !== "text") throw new InteractionValidationError(`${path}.summary[${index}]`, "must be text content");
      return item;
    });
  const signature = optionalString(source.signature, `${path}.signature`);
  return {
    type: "thought",
    ...(summary !== undefined ? { summary } : {}),
    ...(signature !== undefined ? { signature } : {}),
  };
}

function parseFunctionCall(source: Record<string, unknown>, path: string): FunctionCallStep {
  const signature = optionalString(source.signature, `${path}.signature`);
  return {
    type: "function_call",
    id: stringValue(source.id, `${path}.id`),
    name: stringValue(source.name, `${path}.name`),
    arguments: jsonObject(source.arguments, `${path}.arguments`),
    ...(signature !== undefined ? { signature } : {}),
  };
}

function parseFunctionResult(source: Record<string, unknown>, path: string): FunctionResultStep {
  const result = source.result;
  if (result === undefined) throw new InteractionValidationError(`${path}.result`, "is required");
  const name = optionalString(source.name, `${path}.name`);
  const parsedResult = Array.isArray(result) && result.every((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
    return typeof (item as Record<string, unknown>).type === "string" && CONTENT_TYPES.has((item as Record<string, unknown>).type as string);
  })
    ? contentArray(result, `${path}.result`)
    : jsonValue(result, `${path}.result`);
  return {
    type: "function_result",
    call_id: stringValue(source.call_id, `${path}.call_id`),
    result: parsedResult,
    ...(name !== undefined ? { name } : {}),
  };
}

export function parseInteractionStep(value: unknown, path = "step"): InteractionStep {
  const source = record(value, path);
  const type = stringValue(source.type, `${path}.type`);
  if (!STEP_TYPES.has(type)) throw new InteractionValidationError(`${path}.type`, `unsupported step type ${type}`);
  switch (type) {
    case "user_input": return parseUserInput(source, path);
    case "model_output": return parseModelOutput(source, path);
    case "thought": return parseThought(source, path);
    case "function_call": return parseFunctionCall(source, path);
    case "function_result": return parseFunctionResult(source, path);
  }
  throw new InteractionValidationError(`${path}.type`, `unsupported step type ${type}`);
}

function parseTool(value: unknown, path: string): InteractionTool {
  const source = record(value, path);
  if (source.type !== "function") {
    if (typeof source.type === "string" && BUILTIN_TOOL_TYPES.has(source.type as BuiltinToolName)) {
      return { type: source.type as BuiltinToolName };
    }
    throw new InteractionValidationError(`${path}.type`, "unsupported tool type");
  }
  const parameters = source.parameters === undefined ? undefined : jsonValue(source.parameters, `${path}.parameters`);
  return {
    type: "function",
    name: stringValue(source.name, `${path}.name`),
    ...(source.description !== undefined ? { description: stringValue(source.description, `${path}.description`) } : {}),
    ...(parameters !== undefined ? { parameters } : {}),
  };
}

export function parseInteractionInput(value: unknown, path = "input"): InteractionCreateRequest["input"] {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    if (value.length === 0) return [];
    const first = record(value[0], `${path}[0]`);
    if (typeof first.type === "string" && CONTENT_TYPES.has(first.type)) {
      return value.map((item, index) => parseInteractionContent(item, `${path}[${index}]`));
    }
    if (typeof first.type === "string" && !STEP_TYPES.has(first.type)) {
      throw new InteractionValidationError(`${path}[0].type`, `unsupported content or step type "${first.type}"`);
    }
    return value.map((item, index) => parseInteractionStep(item, `${path}[${index}]`));
  }
  const object = record(value, path);
  if (typeof object.type === "string" && CONTENT_TYPES.has(object.type)) return parseInteractionContent(object, path);
  if (typeof object.type === "string" && !STEP_TYPES.has(object.type)) {
    throw new InteractionValidationError(`${path}.type`, `unsupported content or step type "${object.type}"`);
  }
  return parseInteractionStep(object, path);
}

export function parseInteractionCreateRequest(value: unknown): InteractionCreateRequest {
  const source = record(value, "request");
  const model = stringValue(source.model, "request.model");
  if (!model.trim()) throw new InteractionValidationError("request.model", "must not be empty");
  if (!("input" in source)) throw new InteractionValidationError("request.input", "is required");
  const previous = optionalString(source.previous_interaction_id, "request.previous_interaction_id");
  const systemInstruction = optionalString(source.system_instruction, "request.system_instruction");
  if (source.store !== undefined && typeof source.store !== "boolean") {
    throw new InteractionValidationError("request.store", "expected a boolean");
  }
  const tools = source.tools === undefined
    ? undefined
    : Array.isArray(source.tools)
      ? source.tools.map((tool, index) => parseTool(tool, `request.tools[${index}]`))
      : (() => { throw new InteractionValidationError("request.tools", "expected an array"); })();
  const generationConfig = source.generation_config === undefined
    ? undefined
    : jsonObject(source.generation_config, "request.generation_config");
  return {
    model,
    input: parseInteractionInput(source.input),
    ...(previous !== undefined ? { previous_interaction_id: previous } : {}),
    ...(systemInstruction !== undefined ? { system_instruction: systemInstruction } : {}),
    ...(source.store !== undefined ? { store: source.store } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(generationConfig !== undefined ? { generation_config: generationConfig } : {}),
  };
}

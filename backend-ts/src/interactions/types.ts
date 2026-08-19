export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface TextContent {
  readonly type: "text";
  readonly text: string;
}

export interface ImageContent {
  readonly type: "image";
  readonly data?: string;
  readonly uri?: string;
  readonly mime_type?: string;
}

export interface AudioContent {
  readonly type: "audio";
  readonly data?: string;
  readonly uri?: string;
  readonly mime_type?: string;
}

export interface DocumentContent {
  readonly type: "document";
  readonly data?: string;
  readonly uri?: string;
  readonly mime_type?: string;
}

export type InteractionContent = TextContent | ImageContent | AudioContent | DocumentContent;

export interface UserInputStep {
  readonly type: "user_input";
  readonly status?: "done" | "in_progress";
  readonly content: readonly InteractionContent[];
}

export interface ThoughtStep {
  readonly type: "thought";
  readonly status?: "done" | "in_progress";
  readonly summary?: readonly TextContent[];
  readonly signature?: string;
}

export interface ModelOutputStep {
  readonly type: "model_output";
  readonly status?: "done" | "in_progress";
  readonly content: readonly InteractionContent[];
}

export interface FunctionCallStep {
  readonly type: "function_call";
  readonly status?: "waiting" | "done";
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, JsonValue>;
  readonly signature?: string;
}

export interface FunctionResultStep {
  readonly type: "function_result";
  readonly status?: "done" | "in_progress";
  readonly call_id: string;
  readonly name?: string;
  readonly result: JsonValue | readonly InteractionContent[];
}

export type InteractionStep =
  | UserInputStep
  | ThoughtStep
  | ModelOutputStep
  | FunctionCallStep
  | FunctionResultStep;

export interface FunctionTool {
  readonly type: "function";
  readonly name: string;
  readonly description?: string;
  readonly parameters?: JsonValue;
}

export type BuiltinToolName = "google_search" | "code_execution" | "google_maps" | "url_context";

export interface BuiltinTool {
  readonly type: BuiltinToolName;
}

export type InteractionTool = FunctionTool | BuiltinTool;

export interface InteractionCreateRequest {
  readonly model: string;
  readonly input: string | InteractionContent | readonly InteractionContent[] | InteractionStep | readonly InteractionStep[];
  readonly previous_interaction_id?: string;
  readonly store?: boolean;
  readonly system_instruction?: string;
  readonly tools?: readonly InteractionTool[];
  readonly generation_config?: Record<string, JsonValue>;
}

export interface GeminiPart {
  readonly text?: string;
  readonly inlineData?: { readonly mimeType: string; readonly data: string };
  readonly fileData?: { readonly fileUri: string; readonly mimeType?: string };
  readonly functionCall?: { readonly name: string; readonly args: Record<string, JsonValue>; readonly id?: string };
  readonly functionResponse?: { readonly name: string; readonly response: Record<string, JsonValue>; readonly id?: string };
  readonly thought?: boolean;
  readonly thoughtSignature?: string;
}

export interface GeminiContent {
  readonly role: "user" | "model";
  readonly parts: readonly GeminiPart[];
}

export interface GeminiGenerateRequest {
  readonly contents: readonly GeminiContent[];
  readonly systemInstruction?: GeminiContent;
  readonly tools?: readonly InteractionTool[];
  readonly generationConfig?: Record<string, JsonValue>;
}

export interface ModelFunctionCall {
  readonly name: string;
  readonly args: Record<string, JsonValue>;
  readonly call_id?: string;
  readonly thought_signature?: string;
}

export interface ModelOutput {
  readonly text?: string;
  readonly thinking?: string;
  readonly thinking_signature?: string;
  readonly function_calls?: readonly ModelFunctionCall[];
  readonly images?: readonly ImageContent[];
  readonly audio?: readonly AudioContent[];
}

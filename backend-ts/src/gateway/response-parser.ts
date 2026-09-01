import { densifySparseJSON } from "./sparse-json.js";

interface ParsedPart {
  readonly text: string;
  readonly thought: boolean;
  readonly inlineData?: readonly [string, string];
  readonly functionCall?: Record<string, unknown>;
  readonly functionResponse?: Record<string, unknown>;
  readonly thoughtSignature?: string;
}
const FINISH_REASON_NAMES: Readonly<Record<number, string>> = Object.freeze({
  0: "OTHER",
  1: "STOP",
  2: "MAX_TOKENS",
  3: "SAFETY",
  4: "RECITATION",
  5: "OTHER",
  6: "BLOCKLIST",
  7: "PROHIBITED_CONTENT",
  8: "SPII",
  9: "MALFORMED_FUNCTION_CALL",
  10: "IMAGE_SAFETY",
  11: "IMAGE_PROHIBITED_CONTENT",
  12: "IMAGE_RECITATION",
  13: "LANGUAGE",
  14: "NO_IMAGE",
  15: "IMAGE_OTHER",
});

function finishReasonName(candidate: ParsedCandidate): string {
  if (candidate.parts.some(part => "functionCall" in part)) return "FUNCTION_CALL";
  if (candidate.finishReason === undefined) return "STOP";
  return FINISH_REASON_NAMES[candidate.finishReason] ?? "OTHER";
}


export interface ParsedCandidate {
  text: string;
  thinking: string;
  thinkingSignature?: string;
  parts: Record<string, unknown>[];
  finishReason?: number;
  safetyRatings?: unknown[];
}

export interface ParsedAIStudioResponse {
  readonly candidate: ParsedCandidate;
  readonly responseId: string;
  readonly usage: {
    readonly promptTokens: number;
    readonly visibleTokens: number;
    readonly reasoningTokens: number;
    readonly completionTokens: number;
    readonly totalTokens: number;
  };
}

function isIntegerLike(value: unknown): value is number | string {
  if (typeof value === "number") return Number.isInteger(value);
  return typeof value === "string" && /^[+-]?\d+$/u.test(value.trim());
}

function integer(value: unknown): number {
  return isIntegerLike(value) ? Number(value) : 0;
}

function decodeWireValue(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  // google.protobuf.Value uses struct_value at slot 5 and list_value at slot 6.
  // Keep accepting the legacy slot-2 list/object shapes emitted by older
  // captures, but prefer the canonical Struct layout when replaying calls.
  if (
    value.length >= 6
    && value[0] == null
    && value[1] == null
    && value[2] == null
    && value[3] == null
    && value[4] == null
    && Array.isArray(value[5])
  ) {
    const encodedValues = value[5];
    const values = encodedValues.length === 1
      && Array.isArray(encodedValues[0])
      && (encodedValues[0].length === 0 || Array.isArray(encodedValues[0][0]))
      ? encodedValues[0]
      : encodedValues;
    return values.map(decodeWireValue);
  }
  if (
    value.length >= 5
    && value[0] == null
    && value[1] == null
    && value[2] == null
    && value[3] == null
    && Array.isArray(value[4])
  ) {
    return decodeArgumentPairs(value[4]);
  }
  if (value.length >= 2 && value[0] == null && Array.isArray(value[1])) return decodeArgumentPairs(value[1]);
  // JSPB number_value 的 int64/float 表示：[null, value] 或 [null, lo, hi]。
  // 不还原成 number 会把数字以数组形式带进 OpenAI 响应，客户端回传后再次编码错位。
  if (value.length >= 2 && value[0] == null && typeof value[1] === "number") return value[1];
  if (value.length >= 3 && value[0] == null && value[1] == null) {
    return Array.isArray(value[2]) ? value[2].map(decodeWireValue) : value[2];
  }
  return decodeArgumentPairs(value);
}

function decodeArgumentPairs(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  if (value.every(item => Array.isArray(item) && item.length >= 2 && typeof item[0] === "string")) {
    return Object.fromEntries(value.map(item => [item[0] as string, decodeWireValue(item[1])]));
  }
  if (value.length === 1 && Array.isArray(value[0])) return decodeArgumentPairs(value[0]);
  return value.map(decodeWireValue);
}

function functionPayload(value: unknown, type: "functionCall" | "functionResponse"): Record<string, unknown> | undefined {
  if (!Array.isArray(value)) return undefined;
  const payload: Record<string, unknown> = { type, raw: value };
  if (typeof value[0] === "string") payload.name = value[0];
  if (value.length > 1) {
    const args = value[1];
    if (typeof args === "string") {
      try { payload.args = JSON.parse(args); } catch { payload.arguments = args; }
    } else if (Array.isArray(args)) payload.args = decodeArgumentPairs(args);
    else if (args !== undefined) payload.args = args;
  }
  if (typeof value[2] === "string") payload.call_id = value[2];
  return payload;
}

function parsePart(raw: unknown): ParsedPart {
  if (!Array.isArray(raw)) return { text: "", thought: false };
  const thought = typeof raw[10] === "boolean" ? raw[10] : typeof raw[0] === "boolean" ? raw[0] : raw[12] === 1;
  const signature = typeof raw[14] === "string" ? raw[14] : undefined;
  const call = functionPayload(raw[10] ?? raw[3], "functionCall");
  if (call && signature) call.thought_signature = signature;
  return {
    text: typeof raw[1] === "string" ? raw[1] : "",
    thought,
    ...(Array.isArray(raw[2]) && typeof raw[2][0] === "string" && typeof raw[2][1] === "string"
      ? { inlineData: [raw[2][0], raw[2][1]] as const }
      : {}),
    ...(call ? { functionCall: call } : {}),
    ...(functionPayload(raw[11] ?? raw[4], "functionResponse") ? { functionResponse: functionPayload(raw[11] ?? raw[4], "functionResponse")! } : {}),
    ...(signature ? { thoughtSignature: signature } : {}),
  };
}

function looksLikeChunk(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > 0 && Array.isArray(value[0]);
}

function responseChunks(outer: unknown): unknown[][] {
  if (Array.isArray(outer) && outer.length > 0) {
    if (outer.length === 1 && Array.isArray(outer[0])) {
      const nested = outer[0].filter(looksLikeChunk);
      if (nested.length > 0) return nested;
    }
    const top = outer.filter(looksLikeChunk);
    if (top.length > 1) return top;
  }
  return looksLikeChunk(outer) ? [outer] : [];
}

function parseOuter(raw: string): unknown {
  const stripped = raw.trim().replace(/^\)\]\}'\s*/u, "");
  try { return JSON.parse(densifySparseJSON(stripped)); } catch {
    for (const line of stripped.split(/\r?\n/u)) {
      try { return JSON.parse(densifySparseJSON(line)); } catch { /* continue */ }
    }
    throw new Error("AI Studio returned a non-JSON response");
  }
}

export function parseAIStudioResponse(raw: string): ParsedAIStudioResponse {
  const chunks = responseChunks(parseOuter(raw));
  if (chunks.length === 0) throw new Error("AI Studio response did not contain a candidate chunk");
  const candidate: ParsedCandidate = { text: "", thinking: "", parts: [] };
  for (const chunk of chunks) {
    const first = Array.isArray(chunk[0]) ? chunk[0][0] : undefined;
    if (!Array.isArray(first)) continue;
    const content = Array.isArray(first[0]) ? first[0] : undefined;
    const rawParts = content && Array.isArray(content[0]) ? content[0] : [];
    for (const rawPart of rawParts) {
      const part = parsePart(rawPart);
      if (part.thought && part.thoughtSignature && candidate.thinkingSignature === undefined) {
        candidate.thinkingSignature = part.thoughtSignature;
      }
      if (part.text) {
        if (part.thought) candidate.thinking += part.text;
        else candidate.text += part.text;
      }
      if (part.inlineData) {
        candidate.parts.push({
          inlineData: { mimeType: part.inlineData[0], data: part.inlineData[1] },
          ...(part.thought ? { thought: true } : {}),
          ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
        });
      }
      if (part.functionCall) {
        candidate.parts.push({
          functionCall: {
            name: part.functionCall.name ?? "unknown",
            args: part.functionCall.args ?? part.functionCall.arguments ?? {},
            ...(part.functionCall.call_id ? { id: part.functionCall.call_id } : {}),
          },
          ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
        });
      }
      if (part.functionResponse) {
        candidate.parts.push({ functionResponse: { name: part.functionResponse.name ?? "unknown", response: part.functionResponse.args ?? {} } });
      }
    }
    if (typeof first[1] === "number") candidate.finishReason = first[1];
    if (Array.isArray(first[4])) candidate.safetyRatings = first[4];
  }
  if (candidate.thinking) candidate.parts.unshift({
    text: candidate.thinking,
    thought: true,
    ...(candidate.thinkingSignature ? { thoughtSignature: candidate.thinkingSignature } : {}),
  });
  if (candidate.text) candidate.parts.push({ text: candidate.text });
  if (candidate.parts.length === 0) candidate.parts.push({ text: "" });
  const last = chunks.at(-1)!;
  const usage = Array.isArray(last[2]) ? last[2] : [];
  const promptTokens = integer(usage[0]);
  const visibleTokens = integer(usage[1]);
  const reasoningTokens = integer(usage[9]);
  const completionTokens = visibleTokens + reasoningTokens;
  return {
    candidate,
    responseId: typeof last[7] === "string" ? last[7] : "",
    usage: {
      promptTokens,
      visibleTokens,
      reasoningTokens,
      completionTokens,
      totalTokens: integer(usage[2]) || promptTokens + completionTokens,
    },
  };
}

export function toGeminiResponse(parsed: ParsedAIStudioResponse): Record<string, unknown> {
  return {
    candidates: [{
      content: { role: "model", parts: parsed.candidate.parts },
      finishReason: finishReasonName(parsed.candidate),
      ...(parsed.candidate.safetyRatings ? { safetyRatings: parsed.candidate.safetyRatings } : {}),
    }],
    usageMetadata: {
      promptTokenCount: parsed.usage.promptTokens,
      candidatesTokenCount: parsed.usage.visibleTokens,
      thoughtsTokenCount: parsed.usage.reasoningTokens,
      totalTokenCount: parsed.usage.totalTokens,
    },
    ...(parsed.responseId ? { responseId: parsed.responseId } : {}),
  };
}

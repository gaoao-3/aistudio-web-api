import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OpenAiRequestError } from "../src/openai/convert.js";
import {
  convertResponsesRequest,
  createResponsesStreamEncoder,
  responseSessions,
  toResponsesOutputItems,
  toResponsesResponse,
  type ConvertedResponsesRequest,
} from "../src/openai/responses.js";

function throwsCode(fn: () => unknown, code: string | RegExp, statusCode = 400): void {
  assert.throws(fn, (error: unknown) => {
    if (!(error instanceof OpenAiRequestError)) return false;
    if (error.statusCode !== statusCode) return false;
    const pattern = typeof code === "string" ? new RegExp(code) : code;
    return pattern.test(error.message);
  });
}

function geminiResponse(parts: Record<string, unknown>[], finishReason = "STOP"): Record<string, unknown> {
  return {
    candidates: [{ content: { role: "model", parts }, finishReason }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 2, totalTokenCount: 17 },
  };
}

describe("responses request conversion", () => {
  it("sets application/json MIME for text.format.json_object without a schema", () => {
    const converted = convertResponsesRequest({ model: "gemini-3.8-flash", input: "json",
      text: { format: { type: "json_object" } } });
    assert.deepEqual(converted.geminiBody.generationConfig, { responseMimeType: "application/json" });
  });

  it("generates UUID-based response, item and fallback call identifiers", () => {
    const uuid = /^(?:resp|msg|r|fc|call|part)_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
    const converted = convertResponsesRequest({ model: "gemini-3.8-flash", input: "hi" });
    assert.match(converted.responseId, uuid);
    const response = geminiResponse([{ text: "think", thought: true }, { text: "hi" }, { functionCall: { name: "f", args: {} } }]);
    const items = toResponsesOutputItems(response);
    for (const item of items) assert.match(String(item.id), uuid);
    assert.match(String(items[2]!.call_id), uuid);
    const frames = createResponsesStreamEncoder(converted).feed(response).map((frame) => JSON.parse(frame.slice(6)));
    for (const frame of frames) {
      if (frame.item) assert.match(frame.item.id, uuid);
      if (frame.part) assert.match(frame.part.id, uuid);
    }
  });

  it("converts a string input into a user message", () => {
    const converted = convertResponsesRequest({ model: "gemini-3.8-flash", input: "hi" });
    assert.deepEqual(converted.geminiBody.contents, [{ role: "user", parts: [{ text: "hi" }] }]);
  });

  it("converts typed items including function calls and their outputs", () => {
    const converted = convertResponsesRequest({
      model: "gemini-3.8-flash",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "weather?" }] },
        {
          type: "function_call",
          call_id: "call_1",
          name: "getWeather",
          arguments: "{\"city\":\"Beijing\"}",
          extra_content: { google: { thought_signature: "sig-1" } },
        },
        { type: "function_call_output", call_id: "call_1", output: "23C" },
      ],
    });
    const contents = converted.geminiBody.contents as Record<string, unknown>[];
    assert.deepEqual(contents[0], { role: "user", parts: [{ text: "weather?" }] });
    assert.equal(contents[1]?.role, "model");
    const call = (contents[1] as Record<string, unknown>).parts as Record<string, unknown>[];
    assert.equal((call[0]!.functionCall as Record<string, unknown>).name, "getWeather");
    assert.equal((call[0] as Record<string, unknown>).thoughtSignature, "sig-1");
    assert.deepEqual(contents[2], {
      role: "user",
      parts: [{ functionResponse: { name: "getWeather", response: { result: "23C" }, id: "call_1" } }],
    });
  });

  it("accepts legacy messages arrays like chat completions", () => {
    const converted = convertResponsesRequest({
      model: "gemini-3.8-flash",
      input: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hello" },
      ],
    });
    assert.deepEqual(
      (converted.geminiBody.systemInstruction as Record<string, unknown>).parts,
      [{ text: "be brief" }],
    );
    assert.deepEqual(converted.geminiBody.contents, [
      { role: "user", parts: [{ text: "hello" }] },
    ]);
  });

  it("maps instructions, tools, tool_choice, max_output_tokens and effort", () => {
    const converted = convertResponsesRequest({
      model: "gemini-3.8-flash",
      input: "go",
      instructions: "use tools",
      tools: [{ type: "function", name: "f", description: "d", parameters: { type: "object" } }],
      tool_choice: "required",
      max_output_tokens: 512,
      reasoning: { effort: "high" },
    });
    const instruction = (converted.geminiBody.systemInstruction as Record<string, unknown>).parts as Array<{ text?: string }>;
    assert.equal(instruction[0]!.text, "use tools");
    assert.deepEqual(converted.geminiBody.tools, [
      { functionDeclarations: [{ name: "f", description: "d", parameters: { type: "object" } }] },
    ]);
    assert.deepEqual(converted.geminiBody.toolConfig, { functionCallingConfig: { mode: "ANY" } });
    assert.equal((converted.geminiBody.generationConfig as Record<string, unknown>).maxOutputTokens, 512);
    assert.deepEqual((converted.geminiBody.generationConfig as Record<string, unknown>).thinkingConfig, {
      thinkingLevel: "HIGH",
    });
  });

  it("rejects non-function built-in tools with a clear error", () => {
    throwsCode(
      () => convertResponsesRequest({ model: "gemini-3.8-flash", input: "x", tools: [{ type: "web_search" }] }),
      "web_search",
    );
  });

  it("rejects unknown previous_response_id with 404", () => {
    throwsCode(
      () => convertResponsesRequest({ model: "gemini-3.8-flash", input: "x", previous_response_id: "resp_missing" }),
      "previous_response_id 无效",
      404,
    );
  });

  it("maps text.format.json_schema to structured output", () => {
    const converted = convertResponsesRequest({
      model: "gemini-3.8-flash",
      input: "x",
      text: { format: { type: "json_schema", schema: { type: "object", properties: { a: { type: "string" } } } } },
    });
    assert.equal((converted.geminiBody.generationConfig as Record<string, unknown>).responseMimeType, "application/json");
    assert.ok((converted.geminiBody.generationConfig as Record<string, unknown>).responseSchema);
  });
});

describe("responses session replay", () => {
  it("isolates stored responses by caller scope in both output paths", () => {
    responseSessions.clear();
    for (const stream of [false, true]) {
      const first = convertResponsesRequest({ model: "gemini-3.8-flash", input: "secret", stream }, "alice");
      const response = geminiResponse([{ text: "private" }]);
      if (stream) {
        const encoder = createResponsesStreamEncoder(first);
        encoder.feed(response);
        encoder.finish(response);
      } else toResponsesResponse(response, first);
      const body = { model: first.model, input: "next", previous_response_id: first.responseId, store: false };
      throwsCode(() => convertResponsesRequest(body, "bob"), "previous_response_id", 404);
      throwsCode(() => convertResponsesRequest(body), "previous_response_id", 404);
      assert.equal((convertResponsesRequest(body, "alice").geminiBody.contents as unknown[]).length, 3);
      assert.equal(responseSessions.find(first.responseId), undefined);
      assert.ok(responseSessions.find(first.responseId, "alice"));
    }
    responseSessions.clear();
  });

  it("allows store:false to read an existing response without saving the new response", () => {
    responseSessions.clear();
    const first = convertResponsesRequest({ model: "gemini-3.8-flash", input: "hi" });
    toResponsesResponse(geminiResponse([{ text: "hello" }]), first);
    const next = convertResponsesRequest({ model: first.model, input: "bye", previous_response_id: first.responseId, store: false });
    assert.equal((next.geminiBody.contents as unknown[]).length, 3);
    toResponsesResponse(geminiResponse([{ text: "bye" }]), next);
    assert.equal(responseSessions.find(next.responseId), undefined);
    assert.ok(responseSessions.find(first.responseId));
    responseSessions.clear();
  });

  it("retains cumulative user, signed model, and function-result history across three turns", () => {
    responseSessions.clear();
    const first = convertResponsesRequest({ model: "gemini-3.8-flash", input: "weather?" });
    const output = geminiResponse([
      { text: "thinking", thought: true, thoughtSignature: "thought-sig" },
      { functionCall: { name: "weather", args: {}, id: "call_history" }, thoughtSignature: "call-sig" },
    ]);
    toResponsesResponse(output, first);
    const second = convertResponsesRequest({ model: first.model, previous_response_id: first.responseId,
      input: [{ type: "function_call_output", call_id: "call_history", output: "sunny" }] });
    toResponsesResponse(geminiResponse([{ text: "Sunshine", thoughtSignature: "text-sig" }]), second);
    const third = convertResponsesRequest({ model: first.model, previous_response_id: second.responseId, input: "tomorrow?" });
    assert.deepEqual(third.geminiBody.contents, [
      { role: "user", parts: [{ text: "weather?" }] },
      { role: "model", parts: (output.candidates as any[])[0].content.parts },
      { role: "user", parts: [{ functionResponse: { name: "weather", response: { result: "sunny" }, id: "call_history" } }] },
      { role: "model", parts: [{ text: "Sunshine", thoughtSignature: "text-sig" }] },
      { role: "user", parts: [{ text: "tomorrow?" }] },
    ]);
    responseSessions.clear();
  });

  it("replays message items and only replays function_calls with matching outputs", async () => {
    const converted: ConvertedResponsesRequest = {
      model: "gemini-3.8-flash",
      geminiBody: {},
      stream: false,
      store: true,
      responseId: "resp_abc",
    };
    responseSessions.clear();
    responseSessions.remember("resp_abc", "gemini-3.8-flash", [
      { type: "message", content: [{ type: "output_text", text: "earlier" }] },
      { type: "function_call", call_id: "call_9", name: "f", arguments: "{}", extra_content: { google: { thought_signature: "s" } } },
    ]);

    // 不带 output 的续接：function_call 不重放（避免 Gemini 配对约束 400）
    let next = convertResponsesRequest({
      model: "gemini-3.8-flash",
      input: "continue",
      previous_response_id: "resp_abc",
    });
    assert.deepEqual(next.geminiBody.contents, [
      { role: "model", parts: [{ text: "earlier" }] },
      { role: "user", parts: [{ text: "continue" }] },
    ]);

    // 带对应 function_call_output：重放补全配对
    next = convertResponsesRequest({
      model: "gemini-3.8-flash",
      input: [{ type: "function_call_output", call_id: "call_9", output: "ok" }],
      previous_response_id: "resp_abc",
    });
    const contents = next.geminiBody.contents as Record<string, unknown>[];
    assert.equal(contents[1]?.role, "model");
    const call = (contents[1] as Record<string, unknown>).parts as Record<string, unknown>[];
    assert.equal((call[0]!.functionCall as Record<string, unknown>).id, "call_9");
    assert.equal((call[0] as Record<string, unknown>).thoughtSignature, "s");
    assert.deepEqual(contents[2], {
      role: "user",
      parts: [{ functionResponse: { name: "f", response: { result: "ok" }, id: "call_9" } }],
    });
    responseSessions.clear();
  });
});

describe("responses output conversion", () => {
  it("rejects unsupported media instead of silently returning empty output", () => {
    const response = geminiResponse([{ inlineData: { mimeType: "image/png", data: "abc" } }]);
    assert.throws(() => toResponsesOutputItems(response), /media output/u);
    const converted = convertResponsesRequest({ model: "gemini-3.6-flash", input: "image", stream: true });
    assert.throws(() => createResponsesStreamEncoder(converted).feed(response), /media output/u);
  });
  it("builds typed items from text, reasoning and function calls", () => {
    const items = toResponsesOutputItems(geminiResponse([
      { text: "thinking hard", thought: true },
      { text: "result" },
      { functionCall: { name: "f", args: { a: 1 }, id: "call_x" }, thoughtSignature: "sig-2" },
    ]));
    assert.deepEqual(items[0]!.type, "reasoning");
    assert.equal((items[0]!.summary as Record<string, unknown>[])[0]!.text, "thinking hard");
    assert.deepEqual(items[1], {
      id: items[1]!.id,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "result", annotations: [] }],
    });
    assert.equal(items[2]!.type, "function_call");
    assert.equal((items[2] as Record<string, unknown>).call_id, "call_x");
    assert.equal((items[2] as Record<string, unknown>).arguments, "{\"a\":1}");
    assert.deepEqual((items[2] as Record<string, unknown>).extra_content, {
      google: { thought_signature: "sig-2" },
    });
  });

  it("assembles the response envelope with responses-shaped usage", () => {
    const converted: ConvertedResponsesRequest = {
      model: "gemini-3.8-flash",
      geminiBody: {},
      stream: false,
      store: true,
      responseId: "resp_env",
    };
    responseSessions.clear();
    const response = toResponsesResponse(geminiResponse([{ text: "hi" }]), converted);
    assert.equal(response.object, "response");
    assert.equal(response.status, "completed");
    assert.equal(response.model, "gemini-3.8-flash");
    assert.equal((response.output as Array<{ type?: string }>)[0]!.type, "message");
    assert.deepEqual(response.usage, {
      input_tokens: 10,
      output_tokens: 7,
      total_tokens: 17,
      output_tokens_details: { reasoning_tokens: 2 },
    });
    assert.ok(responseSessions.find(String(response.id)));
    responseSessions.clear();
  });
});

describe("responses streaming encoder", () => {
  it("stores streamed cumulative history with signed generated function call IDs", () => {
    responseSessions.clear();
    const first = convertResponsesRequest({ model: "gemini-3.8-flash", input: "start", stream: true });
    const encoder = createResponsesStreamEncoder(first);
    const response = geminiResponse([{ text: "think", thought: true, thoughtSignature: "s1" },
      { functionCall: { name: "f", args: {} }, thoughtSignature: "s2" }]);
    encoder.feed(response);
    const frames = encoder.finish(response).filter((frame) => !frame.includes("[DONE]"))
      .map((frame) => JSON.parse(frame.slice(6)));
    const call = frames.find((frame) => frame.type === "response.completed").response.output
      .find((item: Record<string, unknown>) => item.type === "function_call");
    const next = convertResponsesRequest({ model: first.model, previous_response_id: first.responseId,
      input: [{ type: "function_call_output", call_id: call.call_id, output: "ok" }] });
    assert.deepEqual(next.geminiBody.contents, [
      { role: "user", parts: [{ text: "start" }] },
      { role: "model", parts: [{ text: "think", thought: true, thoughtSignature: "s1" },
        { functionCall: { name: "f", args: {}, id: call.call_id }, thoughtSignature: "s2" }] },
      { role: "user", parts: [{ functionResponse: { name: "f", id: call.call_id, response: { result: "ok" } } }] },
    ]);
    responseSessions.clear();
  });

  it("emits the standard event sequence for streaming text", () => {
    const converted: ConvertedResponsesRequest = {
      model: "gemini-3.8-flash",
      geminiBody: {},
      stream: true,
      store: false,
      responseId: "resp_stream",
    };
    responseSessions.clear();
    const encoder = createResponsesStreamEncoder(converted);
    const frames = [
      ...encoder.feed(geminiResponse([{ text: "Hel" }])),
      ...encoder.feed(geminiResponse([{ text: "lo" }])),
    ].map((frame) => JSON.parse(frame.slice(6)) as Record<string, unknown>);
    const types = frames.map((frame) => frame.type);
    assert.deepEqual(types.slice(0, 2), ["response.created", "response.in_progress"]);
    assert.equal(types[2], "response.output_item.added");
    assert.equal(types[3], "response.content_part.added");
    // 两帧文本只产生一个 message item，两个 delta
    const deltas = frames.filter((frame) => frame.type === "response.output_text.delta");
    assert.equal(deltas.length, 2);
    assert.equal(deltas[0]!.delta, "Hel");
    assert.equal(deltas[1]!.delta, "lo");
    assert.equal(frames.filter((frame) => frame.type === "response.output_item.added").length, 1);

    const done = encoder
      .finish(geminiResponse([{ text: "Hello" }]))
      .filter((frame) => !frame.startsWith("data: [DONE]"))
      .map((frame) => JSON.parse(frame.slice(6)) as Record<string, unknown>);
    const doneTypes = done.map((frame) => frame.type);
    assert.deepEqual(doneTypes, [
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    assert.equal((done[3]!.response as Record<string, unknown>).status, "completed");
  });

  it("emits function_call item events with arguments", () => {
    const converted: ConvertedResponsesRequest = {
      model: "gemini-3.8-flash",
      geminiBody: {},
      stream: true,
      store: false,
      responseId: "resp_fc",
    };
    const encoder = createResponsesStreamEncoder(converted);
    const frames = encoder
      .feed(geminiResponse([{ functionCall: { name: "f", args: { b: 2 }, id: "call_s" }, thoughtSignature: "sig" }]))
      .map((frame) => JSON.parse(frame.slice(6)) as Record<string, unknown>);
    const types = frames.map((frame) => frame.type);
    assert.ok(types.includes("response.output_item.added"));
    assert.ok(types.includes("response.function_call_arguments.delta"));
    assert.ok(types.includes("response.function_call_arguments.done"));
    assert.ok(types.includes("response.output_item.done"));
    const added = frames.find((frame) => frame.type === "response.output_item.added")!.item as Record<string, unknown>;
    assert.equal(added.type, "function_call");
    assert.equal(added.call_id, "call_s");
    assert.equal(added.name, "f");
    const doneItem = frames.find((frame) => frame.type === "response.output_item.done")!.item as Record<string, unknown>;
    assert.equal(doneItem.arguments, "{\"b\":2}");
    assert.deepEqual(doneItem.extra_content, { google: { thought_signature: "sig" } });
  });
});
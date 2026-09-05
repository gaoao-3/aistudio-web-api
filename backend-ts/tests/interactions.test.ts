import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OpenAiRequestError } from "../src/openai/convert.js";
import {
  convertInteractionsRequest,
  createInteractionsStreamEncoder,
  interactionSessions,
  toInteractionResponse,
  toInteractionSteps,
  type ConvertedInteractionsRequest,
} from "../src/openai/interactions.js";

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

describe("interactions request conversion", () => {
  it("accepts official single Content and grouped Content arrays", () => {
    const text = { type: "text", text: "look" };
    assert.deepEqual(convertInteractionsRequest({ model: "m", input: text }).geminiBody.contents,
      [{ role: "user", parts: [{ text: "look" }] }]);
    assert.deepEqual(convertInteractionsRequest({ model: "m", input: [text, { type: "image", mime_type: "image/png", data: "abc" }] }).geminiBody.contents,
      [{ role: "user", parts: [{ text: "look" }, { inlineData: { mimeType: "image/png", data: "abc" } }] }]);
  });
  it("converts a string input and snake_case params", () => {
    const converted = convertInteractionsRequest({
      model: "gemini-3.6-flash",
      input: "hi",
      system_instruction: "be brief",
      generation_config: { temperature: 0.5, thinking_level: "high", max_output_tokens: 100 },
    });
    assert.deepEqual(converted.geminiBody.contents, [{ role: "user", parts: [{ text: "hi" }] }]);
    assert.deepEqual(converted.geminiBody.systemInstruction, {
      role: "user",
      parts: [{ text: "be brief" }],
    });
    assert.deepEqual(converted.geminiBody.generationConfig, {
      temperature: 0.5,
      maxOutputTokens: 100,
      thinkingConfig: { thinkingLevel: "HIGH" },
    });
  });

  it("converts steps incl. thought, function_call and function_result", () => {
    const converted = convertInteractionsRequest({
      model: "gemini-3.6-flash",
      input: [
        { type: "user_input", content: [{ type: "text", text: "weather?" }] },
        { type: "thought", summary: [{ type: "text", text: "thinking" }], signature: "sig-1" },
        { type: "function_call", id: "fc_1", name: "getWeather", arguments: { city: "Beijing" } },
        { type: "function_result", call_id: "fc_1", result: { temperature: 23 } },
      ],
    });
    const contents = converted.geminiBody.contents as Record<string, unknown>[];
    assert.deepEqual(contents[0], { role: "user", parts: [{ text: "weather?" }] });
    assert.deepEqual(contents[1]!.parts, [
      { text: "thinking", thought: true, thoughtSignature: "sig-1" },
    ]);
    assert.deepEqual(contents[2]!.parts, [
      { functionCall: { name: "getWeather", args: { city: "Beijing" }, id: "fc_1" } },
    ]);
    assert.deepEqual(contents[3]!.parts, [
      { functionResponse: { name: "getWeather", response: { temperature: 23 }, id: "fc_1" } },
    ]);
  });

  it("maps server-side tools and function tools into gemini tools", () => {
    const converted = convertInteractionsRequest({
      model: "gemini-3.6-flash",
      input: "search",
      tools: [
        { type: "function", name: "f", description: "d", parameters: { type: "object" } },
        { type: "google_search" },
        { type: "code_execution" },
      ],
    });
    assert.deepEqual(converted.geminiBody.tools, [
      { functionDeclarations: [{ type: "function", name: "f", description: "d", parameters: { type: "object" } }] },
      { googleSearch: {}, codeExecution: {} },
    ]);
    throwsCode(
      () => convertInteractionsRequest({ model: "gemini-3.6-flash", input: "x", tools: [{ type: "web_search" }] }),
      "web_search",
    );
  });

  it("maps official response_format image strings and schema", () => {
    const converted = convertInteractionsRequest({
      model: "gemini-3.1-flash-image",
      input: "draw",
      response_format: [{ type: "image", aspect_ratio: "16:9", image_size: "2K" }, { type: "text" }],
    });
    assert.deepEqual(converted.geminiBody.generationConfig, {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: { aspectRatio: "16:9", imageSize: "2K" },
    });
    const json = convertInteractionsRequest({
      model: "gemini-3.6-flash",
      input: "x",
      response_format: { type: "text", schema: { type: "object", properties: { a: { type: "string" } } } },
    });
    assert.equal((json.geminiBody.generationConfig as Record<string, unknown>).responseMimeType, "application/json");
    throwsCode(
      () => convertInteractionsRequest({ model: "gemini-3.6-flash", input: "x", response_format: { type: "audio" } }),
      "audio",
    );
  });

  it("accepts stored nonstream background execution and rejects invalid combinations", () => {
    assert.equal(convertInteractionsRequest({ model: "m", input: "x", background: true }).background, true);
    throwsCode(() => convertInteractionsRequest({ model: "m", input: "x", background: true, stream: true }), "background");
    throwsCode(
      () => convertInteractionsRequest({ model: "gemini-3.6-flash", input: "x", background: true, store: false }),
      "background",
    );
    throwsCode(
      () => convertInteractionsRequest({ model: "gemini-3.6-flash", input: "x", previous_interaction_id: "int_missing" }),
      "previous_interaction_id 无效",
      404,
    );
  });
});

describe("interactions session replay", () => {
  it("keeps cumulative paired history scoped to the caller, including read-only continuations", () => {
    interactionSessions.clear();
    const first = convertInteractionsRequest({ model: "m", input: "question" }, "alice");
    assert.match(first.interactionId, /^int_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    toInteractionResponse(geminiResponse([{ functionCall: { name: "f", args: {}, id: "c" }, thoughtSignature: "signed" }]), first);
    throwsCode(() => convertInteractionsRequest({ model: "m", input: "x", previous_interaction_id: first.interactionId }, "bob"), "previous_interaction_id", 404);
    const second = convertInteractionsRequest({ model: "m", input: [{ type: "function_result", call_id: "c", result: { ok: true } }], previous_interaction_id: first.interactionId }, "alice");
    assert.deepEqual(second.geminiBody.contents, [
      { role: "user", parts: [{ text: "question" }] },
      { role: "model", parts: [{ functionCall: { name: "f", args: {}, id: "c" }, thoughtSignature: "signed" }] },
      { role: "user", parts: [{ functionResponse: { name: "f", id: "c", response: { ok: true } } }] },
    ]);
    toInteractionResponse(geminiResponse([{ text: "answer", thoughtSignature: "text-sig" }]), second);
    const third = convertInteractionsRequest({ model: "m", input: "next", store: false, previous_interaction_id: second.interactionId }, "alice");
    assert.deepEqual(third.geminiBody.contents, [...second.geminiBody.contents as unknown[],
      { role: "model", parts: [{ text: "answer", thoughtSignature: "text-sig" }] },
      { role: "user", parts: [{ text: "next" }] }]);
    toInteractionResponse(geminiResponse([{ text: "no store" }]), third);
    assert.equal(interactionSessions.find(third.interactionId, "alice"), undefined);
    assert.equal(interactionSessions.size, 2);
    interactionSessions.clear();
  });
  it("replays output steps and pairs function results", async () => {
    interactionSessions.clear();
    interactionSessions.remember("int_abc", "gemini-3.6-flash", [
      { type: "thought", summary: [{ type: "text", text: "t1" }], signature: "sig9" },
      { type: "model_output", content: [{ type: "text", text: "earlier" }] },
      { type: "function_call", id: "fc_7", name: "f", arguments: { x: 1 }, signature: "sig8" },
    ]);

    // 纯聊天续接：function_call 不重放（配对约束）
    let next = convertInteractionsRequest({
      model: "gemini-3.6-flash",
      input: "continue",
      previous_interaction_id: "int_abc",
    });
    assert.deepEqual(next.geminiBody.contents, [
      { role: "model", parts: [{ text: "t1", thought: true, thoughtSignature: "sig9" }] },
      { role: "model", parts: [{ text: "earlier" }] },
      { role: "user", parts: [{ text: "continue" }] },
    ]);

    // 带回 function_result：重放补全配对
    next = convertInteractionsRequest({
      model: "gemini-3.6-flash",
      input: [{ type: "function_result", call_id: "fc_7", output: "ok" }],
      previous_interaction_id: "int_abc",
    });
    const contents = next.geminiBody.contents as Record<string, unknown>[];
    assert.equal(contents.length, 4);
    assert.deepEqual(contents[2]!.parts, [
      { functionCall: { name: "f", args: { x: 1 }, id: "fc_7" }, thoughtSignature: "sig8" },
    ]);
    assert.deepEqual(contents[3]!.parts, [
      { functionResponse: { name: "f", response: "ok", id: "fc_7" } },
    ]);
    interactionSessions.clear();
  });
});

describe("interactions response conversion", () => {
  it("uses current SDK usage fields and preserves token-limit status", () => {
    const request = convertInteractionsRequest({ model: "gemini-3.6-flash", input: "hi" });
    const response = toInteractionResponse(geminiResponse([{ text: "partial" }], "MAX_TOKENS"), request);
    assert.equal(response.model, request.model);
    assert.equal(response.status, "incomplete");
    assert.equal((response.usage as Record<string, unknown>).total_input_tokens, 10);
  });
  it("converts inlineData objects without losing media order or signatures", () => {
    assert.deepEqual(toInteractionSteps(geminiResponse([
      { inlineData: { mimeType: "image/png", data: "img" } },
      { text: "caption" }, { inlineData: { mimeType: "audio/wav", data: "snd" } },
      { thought: true, thoughtSignature: "only-signature" },
    ])), [
      { type: "model_output", content: [{ type: "image", mime_type: "image/png", data: "img" }, { type: "text", text: "caption" }, { type: "audio", mime_type: "audio/wav", data: "snd" }] },
      { type: "thought", summary: [], signature: "only-signature" },
    ]);
  });
  it("assembles steps with thought, function_call and model_output", () => {
    const interaction = toInteractionResponse(
      geminiResponse([
        { text: "think", thought: true, thoughtSignature: "sig-a" },
        { text: "answer" },
        { functionCall: { name: "f", args: { a: 1 }, id: "call_1" }, thoughtSignature: "sig-b" },
        { text: "more" },
      ]),
      {
        model: "gemini-3.6-flash",
        geminiBody: {},
        stream: false,
        store: true,
        interactionId: "int_env",
      } as ConvertedInteractionsRequest,
    );
    assert.equal(interaction.object, "interaction");
    assert.equal(interaction.status, "requires_action");
    const steps = interaction.steps as Record<string, unknown>[];
    assert.deepEqual(steps[0], {
      type: "thought",
      summary: [{ type: "text", text: "think" }],
      signature: "sig-a",
    });
    // function_call 前后的文本保持原顺序，各自独立成 model_output step
    assert.deepEqual((steps[1] as Record<string, unknown>).content, [
      { type: "text", text: "answer" },
    ]);
    assert.equal((steps[2] as Record<string, unknown>).type, "function_call");
    assert.equal((steps[2] as Record<string, unknown>).id, "call_1");
    assert.deepEqual((steps[3] as Record<string, unknown>).content, [
      { type: "text", text: "more" },
    ]);
    assert.ok(interactionSessions.find(String(interaction.id)));
    interactionSessions.clear();
  });

  it("marks completed when no function call is present", () => {
    const steps = toInteractionSteps(geminiResponse([{ text: "hi" }]));
    assert.equal(steps.length, 1);
    assert.equal(steps[0]!.type, "model_output");
    const response = toInteractionResponse(geminiResponse([{ text: "hi" }]), {
      model: "gemini-3.6-flash",
      geminiBody: {},
      stream: false,
      store: false,
      interactionId: "int_ok",
    } as ConvertedInteractionsRequest);
    assert.equal(response.status, "completed");
    assert.deepEqual(response.usage, {
      total_input_tokens: 10,
      total_output_tokens: 5,
      total_thought_tokens: 2,
      total_cached_tokens: 0,
      prompt_tokens: 10,
      completion_tokens: 7,
      total_tokens: 17,
    });
  });
});

describe("interactions streaming encoder", () => {
  it("streams media and signature-only thoughts without dropping content", () => {
    const converted = convertInteractionsRequest({ model: "gemini-3.6-flash", input: "image", stream: true });
    const encoder = createInteractionsStreamEncoder(converted);
    const response = geminiResponse([{ thought: true, thoughtSignature: "sig-only" }, { inlineData: { mimeType: "image/png", data: "abc" } }]);
    const frames = [...encoder.feed(response), ...encoder.finish(response)];
    const data = frames.filter(f => f.includes("data: {")).map(f => JSON.parse(f.split("data: ")[1]!.trim()));
    assert.ok(data.some(e => e.delta?.type === "image" && e.delta.data === "abc"));
    assert.ok(data.some(e => e.delta?.type === "thought_signature" && e.delta.signature === "sig-only"));
  });
  it("emits the official event sequence with step deltas", () => {
    const converted: ConvertedInteractionsRequest = {
      model: "gemini-3.6-flash",
      geminiBody: {},
      stream: true,
      store: false,
      interactionId: "int_stream",
    };
    interactionSessions.clear();
    const encoder = createInteractionsStreamEncoder(converted);
    const frames = [
      ...encoder.feed(geminiResponse([{ text: "Hel" }])),
      ...encoder.feed(geminiResponse([{ text: "lo" }])),
    ];
    const events = frames
      .filter((frame) => frame.startsWith("event:"))
      .map((frame) => {
        const match = /^event: (\S+)$/mu.exec(frame);
        return match?.[1] ?? "";
      });
    assert.deepEqual(events.slice(0, 2), ["interaction.created", "interaction.status_update"]);
    assert.equal(events[2], "step.start");
    // 两帧文本：一个 model_output step，两个 delta
    const deltas = frames
      .filter((frame) => frame.includes('"delta":{"type":"text"'))
      .map((frame) => {
        const match = /\{"type":"text","text":"([^"]*)"\}/u.exec(frame);
        return match?.[1] ?? "";
      });
    assert.deepEqual(deltas, ["Hel", "lo"]);

    const done = encoder.finish(geminiResponse([{ text: "Hello" }]));
    const doneEvents = done
      .filter((frame) => frame.startsWith("event:"))
      .map((frame) => /^event: (\S+)$/mu.exec(frame)?.[1] ?? "");
    assert.ok(doneEvents.includes("interaction.completed"));
    assert.ok(done.some((frame) => frame === "data: [DONE]\n\n"));
  });

  it("emits function_call steps with arguments delta", () => {
    const converted: ConvertedInteractionsRequest = {
      model: "gemini-3.6-flash",
      geminiBody: {},
      stream: true,
      store: false,
      interactionId: "int_fc",
    };
    const encoder = createInteractionsStreamEncoder(converted);
    const frames = encoder.feed(geminiResponse([{ functionCall: { name: "f", args: { b: 2 }, id: "call_s" }, thoughtSignature: "sig" }]));
    const start = frames.find((frame) => frame.includes('"step":{"type":"function_call","id":"call_s","name":"f","arguments":{}}'));
    assert.ok(start);
    const callDelta = frames.find((frame) => frame.includes("arguments_delta"));
    assert.ok(callDelta);
    const payload = JSON.parse((callDelta ?? "").split("data: ")[1]!.trim());
    assert.deepEqual(payload.delta, { type: "arguments_delta", arguments: '{"b":2}' });
  });
});
import assert from "node:assert/strict";
import test from "node:test";
import {
  inputToContents,
  interactionToGeminiRequest,
  outputToSteps,
  parseInteractionCreateRequest,
  stepsToContents,
} from "../src/index.js";

test("preserves function call id and thought signature", () => {
  const contents = stepsToContents([
    {
      type: "function_call",
      id: "call-1",
      name: "run_code",
      arguments: { language: "python", code: "print(1)" },
      signature: "sig-1",
    },
  ]);

  assert.equal(contents[0]?.role, "model");
  assert.deepEqual(contents[0]?.parts[0]?.functionCall, {
    name: "run_code",
    args: { language: "python", code: "print(1)" },
    id: "call-1",
  });
  assert.equal(contents[0]?.parts[0]?.thoughtSignature, "sig-1");
});

test("resolves a function result name from the previous call", () => {
  const contents = stepsToContents([
    { type: "function_call", id: "call-2", name: "get_weather", arguments: {} },
    { type: "function_result", call_id: "call-2", result: [{ type: "text", text: "晴天" }] },
  ]);

  assert.deepEqual(contents[1]?.parts[0]?.functionResponse, {
    name: "get_weather",
    response: { result: "晴天" },
    id: "call-2",
  });
});

test("does not pass a raw content array to a function response", () => {
  const contents = inputToContents({
    type: "function_result",
    call_id: "call-3",
    name: "run_code",
    result: [
      { type: "text", text: "stdout" },
      { type: "image", data: "abc", mime_type: "image/gif" },
    ],
  });

  const result = contents[0]?.parts[0]?.functionResponse?.response.result;
  assert.equal(typeof result, "string");
  assert.match(String(result), /stdout/);
});

test("builds a request from history and current input", () => {
  const request = interactionToGeminiRequest(
    { model: "gemini-3.6-flash", input: "继续回答" },
    [{ type: "user_input", content: [{ type: "text", text: "第一轮" }] }],
  );

  assert.deepEqual(request.contents.map((content) => content.parts[0]?.text), ["第一轮", "继续回答"]);
});

test("preserves Google Files URIs in multimedia content", () => {
  const request = interactionToGeminiRequest({
    model: "gemini-3.6-flash",
    input: { type: "document", uri: "https://generativelanguage.googleapis.com/v1beta/files/file_42", mime_type: "application/pdf" },
  });

  assert.deepEqual(request.contents[0]?.parts[0]?.fileData, {
    fileUri: "https://generativelanguage.googleapis.com/v1beta/files/file_42",
    mimeType: "application/pdf",
  });
});

test("synthesizes a call id when the model tool call has none", () => {
  const steps = outputToSteps({ function_calls: [{ name: "run_code", args: {} }] });
  const call = steps.find(step => step.type === "function_call");
  assert.ok(call && call.type === "function_call");
  assert.match(call.id, /^call_[0-9a-f]{24}$/u);
});

test("validates external Interactions JSON before conversion", () => {
  const request = parseInteractionCreateRequest({
    model: "gemini-3.6-flash",
    input: {
      type: "function_result",
      call_id: "call-4",
      result: { stdout: "ok", resource_filter: [null, { source: "history" }] },
    },
  });

  assert.equal(request.model, "gemini-3.6-flash");
  assert.deepEqual(request.input, {
    type: "function_result",
    call_id: "call-4",
    result: { stdout: "ok", resource_filter: [null, { source: "history" }] },
  });
});

test("accepts AI Studio built-in tools", () => {
  const request = parseInteractionCreateRequest({
    model: "gemini-3.6-flash",
    input: "搜索今天的新闻",
    tools: [{ type: "google_search" }, { type: "code_execution" }],
  });

  assert.deepEqual(request.tools, [{ type: "google_search" }, { type: "code_execution" }]);
  assert.deepEqual(interactionToGeminiRequest(request).tools, request.tools);
});

test("reports the exact path for malformed function arguments", () => {
  assert.throws(
    () => parseInteractionCreateRequest({
      model: "gemini-3.6-flash",
      input: {
        type: "function_call",
        id: "call-5",
        name: "run_code",
        arguments: { resource_filter: undefined },
      },
    }),
    /input\.arguments\.resource_filter: /,
  );
});

test("maps generation_config onto the generateContent camelCase names", () => {
  const request = parseInteractionCreateRequest({
    model: "gemini-3.6-flash",
    input: "你好",
    generation_config: {
      thinking_level: "low",
      temperature: 0.4,
      top_p: 0.8,
      max_output_tokens: 512,
      image_config: { aspect_ratio: "1:1", image_size: "1K" },
    },
  });

  assert.deepEqual(interactionToGeminiRequest(request).generationConfig, {
    thinkingConfig: { thinkingLevel: "low" },
    temperature: 0.4,
    topP: 0.8,
    maxOutputTokens: 512,
    imageConfig: { aspectRatio: "1:1", imageSize: "1K" },
  });
});

test("omits generationConfig when the request carries no generation_config", () => {
  const request = parseInteractionCreateRequest({ model: "gemini-3.6-flash", input: "你好" });
  assert.equal(interactionToGeminiRequest(request).generationConfig, undefined);
});

test("rejects media content that carries neither inline data nor a uri", () => {
  const request = parseInteractionCreateRequest({
    model: "gemini-3.6-flash",
    // The Interactions API spells inline images as data + mime_type; an
    // OpenAI-style image_url is not silently dropped.
    input: [{ type: "image", image_url: "data:image/png;base64,AAAA" }],
  });

  assert.throws(() => interactionToGeminiRequest(request), /image content requires/u);
});

test("attaches a thinking signature to the thought step", () => {
  const steps = outputToSteps({ thinking: "推理过程", thinking_signature: "sig-think" });
  assert.deepEqual(steps[0], {
    type: "thought",
    status: "done",
    summary: [{ type: "text", text: "推理过程" }],
    signature: "sig-think",
  });
});

test("replays a thought signature even without a summary", () => {
  const contents = stepsToContents([{ type: "thought", signature: "sig-only" }]);
  assert.deepEqual(contents[0]?.parts, [{ text: "", thought: true, thoughtSignature: "sig-only" }]);
});

test("puts a thought signature only on the first summary part", () => {
  const contents = stepsToContents([{
    type: "thought",
    signature: "sig-multi",
    summary: [
      { type: "text", text: "第一段" },
      { type: "text", text: "第二段" },
    ],
  }]);
  assert.equal(contents[0]?.parts[0]?.thoughtSignature, "sig-multi");
  assert.equal(contents[0]?.parts[1]?.thoughtSignature, undefined);
});

test("rejects unsupported generation_config keys instead of dropping them", () => {
  assert.throws(
    () => interactionToGeminiRequest({ model: "m", input: "hi", generation_config: { response_mime_type: "application/json" } }),
    /generation_config\.response_mime_type is not supported/,
  );
});

test("rejects invalid thinking_level values", () => {
  assert.throws(
    () => interactionToGeminiRequest({ model: "m", input: "hi", generation_config: { thinking_level: { x: 1 } as never } }),
    /thinking_level must be one of/,
  );
  assert.throws(
    () => interactionToGeminiRequest({ model: "m", input: "hi", generation_config: { thinking_level: "ultra" } }),
    /thinking_level must be one of/,
  );
});

test("rejects non-numeric generation_config numbers", () => {
  assert.throws(
    () => interactionToGeminiRequest({ model: "m", input: "hi", generation_config: { temperature: "hot" as never } }),
    /generation_config\.temperature must be a number/,
  );
});

test("maps supported generation_config fields", () => {
  const request = interactionToGeminiRequest({
    model: "m",
    input: "hi",
    generation_config: { temperature: 0.5, max_output_tokens: 64, thinking_level: "low", stop_sequences: ["END"] },
  });
  assert.deepEqual(request.generationConfig, {
    temperature: 0.5,
    maxOutputTokens: 64,
    thinkingConfig: { thinkingLevel: "low" },
    stopSequences: ["END"],
  });
});

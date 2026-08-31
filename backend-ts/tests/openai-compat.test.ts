import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ApiKeyStore } from "../src/auth/api-key-store.js";
import { buildApp } from "../src/app.js";
import { createChatStreamEncoder } from "../src/openai/convert.js";
import type { BackendBridge } from "../src/bridge/backend-bridge.js";

class MockBridge implements BackendBridge {
  readonly calls: Array<{
    method: string;
    params: Readonly<Record<string, unknown>>;
  }> = [];
  streamChunks: string[] = [];
  generateResponses: unknown[] = [];

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  status(): Readonly<{ running: boolean; pid?: number }> {
    return { running: true };
  }

  async request<T>(
    method: string,
    params: Readonly<Record<string, unknown>> = {},
    onChunk?: (chunk: string) => void,
    _signal?: AbortSignal,
  ): Promise<T> {
    this.calls.push({ method, params });
    if (method === "models") return [] as T;
    if (method === "generate") {
      if (this.generateResponses.length > 0) return this.generateResponses.shift() as T;
      if (onChunk) {
        for (const chunk of this.streamChunks) onChunk(chunk);
        return {
          candidates: [
            {
              content: { role: "model", parts: [{ text: "streamed" }] },
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            promptTokenCount: 3,
            candidatesTokenCount: 2,
            thoughtsTokenCount: 1,
            totalTokenCount: 6,
          },
        } as T;
      }
      return {
        candidates: [
          {
            content: { role: "model", parts: [{ text: "ok" }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 5,
          candidatesTokenCount: 7,
          thoughtsTokenCount: 2,
          totalTokenCount: 14,
        },
      } as T;
    }
    return { ok: true } as T;
  }
}

function isRecordForTest(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function fixture(bridge = new MockBridge()) {
  const directory = await mkdtemp(join(tmpdir(), "aistudio-openai-"));
  const apiKeys = new ApiKeyStore(join(directory, "apikeys.json"));
  const app = await buildApp({
    services: { bridge, apiKeys },
    logger: false,
    serveStatic: false,
    runtimeConfigFile: join(directory, ".env"),
  });
  return { app, bridge, directory };
}

test("OpenAI chat completions converts request and response shapes", async (t) => {
  const state = await fixture();
  t.after(async () => {
    await state.app.close();
    await rm(state.directory, { recursive: true, force: true });
  });

  const response = await state.app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    payload: {
      model: "gemini-3-flash-preview",
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "how are you?" },
      ],
      temperature: 0.5,
      top_p: 0.9,
      max_tokens: 128,
      stop: ["END"],
      response_format: { type: "json_object" },
    },
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.object, "chat.completion");
  assert.equal(body.model, "gemini-3-flash-preview");
  assert.equal(body.choices[0].message.role, "assistant");
  assert.equal(body.choices[0].message.content, "ok");
  assert.equal(body.choices[0].finish_reason, "stop");
  assert.deepEqual(body.usage, {
    prompt_tokens: 5,
    completion_tokens: 9,
    total_tokens: 14,
  });

  const call = state.bridge.calls.find((item) => item.method === "generate");
  assert.ok(call);
  assert.equal(call.params.model, "gemini-3-flash-preview");
  const gemini = call.params.body as Record<string, unknown>;
  assert.deepEqual(gemini.systemInstruction, {
    role: "user",
    parts: [{ text: "Be terse." }],
  });
  const contents = gemini.contents as Array<{ role: string; parts: unknown[] }>;
  assert.deepEqual(
    contents.map((content) => content.role),
    ["user", "model", "user"],
  );
  const generationConfig = gemini.generationConfig as Record<string, unknown>;
  assert.equal(generationConfig.temperature, 0.5);
  assert.equal(generationConfig.topP, 0.9);
  assert.equal(generationConfig.maxOutputTokens, 128);
  assert.deepEqual(generationConfig.stopSequences, ["END"]);
  assert.equal(generationConfig.responseMimeType, "application/json");
});

test("OpenAI tools, tool_choice and tool result messages map to Gemini calls", async (t) => {
  const state = await fixture();
  t.after(async () => {
    await state.app.close();
    await rm(state.directory, { recursive: true, force: true });
  });

  const response = await state.app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    payload: {
      model: "gemini-3-flash-preview",
      messages: [
        { role: "user", content: "weather in Beijing?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "get_weather",
                arguments: '{"city":"Beijing"}',
              },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "sunny" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get weather",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
            },
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "get_weather" } },
    },
  });

  assert.equal(response.statusCode, 200);
  const call = state.bridge.calls.find((item) => item.method === "generate");
  assert.ok(call);
  const gemini = call.params.body as Record<string, unknown>;
  const tools = gemini.tools as Array<{
    functionDeclarations: Array<{ name: string }>;
  }>;
  assert.equal(tools[0]!.functionDeclarations[0]!.name, "get_weather");
  assert.deepEqual(gemini.toolConfig, {
    functionCallingConfig: {
      mode: "ANY",
      allowedFunctionNames: ["get_weather"],
    },
  });
  const contents = gemini.contents as Array<{
    role: string;
    parts: Array<Record<string, unknown>>;
  }>;
  const callPart = contents[1]!.parts[0]!.functionCall as Record<
    string,
    unknown
  >;
  assert.equal(callPart.name, "get_weather");
  assert.equal(callPart.id, "call_1");
  const responsePart = contents[2]!.parts[0]!.functionResponse as Record<
    string,
    unknown
  >;
  assert.equal(responsePart.name, "get_weather");
});

test("OpenAI tool-call responses round-trip Gemini thought signatures", async (t) => {
  const bridge = new MockBridge();
  bridge.generateResponses = [
    {
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              {
                functionCall: {
                  name: "get_weather",
                  args: { city: "Beijing" },
                  id: "call_1",
                },
                thoughtSignature: "sig_1",
              },
            ],
          },
          finishReason: "FUNCTION_CALL",
        },
      ],
    },
    {
      candidates: [
        {
          content: { role: "model", parts: [{ text: "sunny" }] },
          finishReason: "STOP",
        },
      ],
    },
  ];
  const state = await fixture(bridge);
  t.after(async () => {
    await state.app.close();
    await rm(state.directory, { recursive: true, force: true });
  });

  const tools = [
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "Get weather",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
        },
      },
    },
  ];
  const first = await state.app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    payload: {
      model: "gemini-3-flash-preview",
      messages: [{ role: "user", content: "weather in Beijing?" }],
      tools,
    },
  });
  assert.equal(first.statusCode, 200);
  const assistant = first.json().choices[0].message as Record<string, unknown>;
  const firstCall = (assistant.tool_calls as Array<Record<string, unknown>>)[0]!;
  assert.deepEqual(firstCall.extra_content, {
    google: { thought_signature: "sig_1" },
  });

  const second = await state.app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    payload: {
      model: "gemini-3-flash-preview",
      messages: [
        { role: "user", content: "weather in Beijing?" },
        assistant,
        { role: "tool", tool_call_id: "call_1", content: "sunny" },
      ],
      tools,
    },
  });
  assert.equal(second.statusCode, 200);
  const generateCalls = state.bridge.calls.filter((item) => item.method === "generate");
  assert.equal(generateCalls.length, 2);
  const secondBody = generateCalls[1]!.params.body as Record<string, unknown>;
  const secondContents = secondBody.contents as Array<{
    role: string;
    parts: Array<Record<string, unknown>>;
  }>;
  assert.equal(secondContents[1]!.parts[0]!.thoughtSignature, "sig_1");
  const functionResponse = secondContents[2]!.parts[0]!.functionResponse as Record<string, unknown>;
  assert.equal(functionResponse.id, "call_1");
});

test("OpenAI streaming tool-call deltas preserve thought signatures", () => {
  const encoder = createChatStreamEncoder("gemini-3-flash-preview", false);
  const frames = encoder.feed({
    candidates: [
      {
        content: {
          role: "model",
          parts: [
            {
              functionCall: {
                name: "get_weather",
                args: { city: "Beijing" },
                id: "call_1",
              },
              thoughtSignature: "sig_1",
            },
          ],
        },
        finishReason: "FUNCTION_CALL",
      },
    ],
  });
  const payloads = frames.map((frame) => JSON.parse(frame.slice("data: ".length)) as Record<string, unknown>);
  const toolPayload = payloads.find((payload) => {
    const choices = payload.choices;
    if (!Array.isArray(choices) || !isRecordForTest(choices[0])) return false;
    const delta = choices[0].delta;
    return isRecordForTest(delta) && Array.isArray(delta.tool_calls);
  });
  assert.ok(toolPayload);
  const choices = toolPayload.choices as Array<Record<string, unknown>>;
  const delta = choices[0]!.delta as Record<string, unknown>;
  const call = (delta.tool_calls as Array<Record<string, unknown>>)[0]!;
  assert.deepEqual(call.extra_content, {
    google: { thought_signature: "sig_1" },
  });
});

test("OpenAI streaming chat completions emits chat.completion.chunk frames and [DONE]", async (t) => {
  const bridge = new MockBridge();
  bridge.streamChunks = [
    'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Hel"}]}}]}\n\n',
    'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"lo"}]}}]}\n\n',
    'data: {"candidates":[{"content":{"role":"model","parts":[{"text":""}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2,"thoughtsTokenCount":1,"totalTokenCount":6}}\n\n',
  ];
  const state = await fixture(bridge);
  t.after(async () => {
    await state.app.close();
    await rm(state.directory, { recursive: true, force: true });
  });

  const response = await state.app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    payload: {
      model: "gemini-3-flash-preview",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      stream_options: { include_usage: true },
    },
  });

  assert.equal(response.statusCode, 200);
  assert.match(String(response.headers["content-type"]), /text\/event-stream/u);
  const raw = response.body;
  assert.match(raw, /data: \[DONE\]\n\n$/u);
  const frames = raw
    .split("\n\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map(
      (line) =>
        JSON.parse(line.slice("data: ".length)) as Record<string, unknown>,
    );
  assert.ok(frames.length >= 4);
  for (const frame of frames) {
    assert.equal(frame.object, "chat.completion.chunk");
    assert.equal(frame.model, "gemini-3-flash-preview");
  }
  const deltas = frames.flatMap((frame) =>
    (frame.choices as Array<{ delta: Record<string, unknown> }>).map(
      (choice) => choice.delta,
    ),
  );
  assert.equal(deltas[0]!.role, "assistant");
  assert.equal(deltas.map((delta) => delta.content ?? "").join(""), "Hello");
  const last = frames.at(-1)!;
  assert.equal(
    (last.choices as Array<{ finish_reason: string }>)[0]!.finish_reason,
    "stop",
  );
  assert.deepEqual(last.usage, {
    prompt_tokens: 3,
    completion_tokens: 3,
    total_tokens: 6,
  });
});

test("OpenAI models list uses OpenAI format while v1beta keeps Gemini format", async (t) => {
  const state = await fixture();
  t.after(async () => {
    await state.app.close();
    await rm(state.directory, { recursive: true, force: true });
  });

  const openAi = await state.app.inject({ method: "GET", url: "/v1/models" });
  assert.equal(openAi.statusCode, 200);
  assert.equal(openAi.json().object, "list");
  assert.ok(Array.isArray(openAi.json().data));
  for (const model of openAi.json().data as Array<Record<string, unknown>>) {
    assert.equal(model.object, "model");
    assert.equal(typeof model.id, "string");
    assert.equal(model.owned_by, "google-ai-studio");
  }

  const gemini = await state.app.inject({
    method: "GET",
    url: "/v1beta/models",
  });
  assert.equal(gemini.statusCode, 200);
  assert.ok(Array.isArray(gemini.json().models));
});

test("OpenAI request validation errors use the OpenAI error envelope", async (t) => {
  const state = await fixture();
  t.after(async () => {
    await state.app.close();
    await rm(state.directory, { recursive: true, force: true });
  });

  const missingModel = await state.app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    payload: { messages: [{ role: "user", content: "hi" }] },
  });
  assert.equal(missingModel.statusCode, 400);
  assert.equal(missingModel.json().error.type, "invalid_request_error");
  assert.match(missingModel.json().error.message, /model/u);

  const missingMessages = await state.app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    payload: { model: "gemini-3-flash-preview" },
  });
  assert.equal(missingMessages.statusCode, 400);
  assert.match(missingMessages.json().error.message, /messages/u);

  const remoteImage = await state.app.inject({
    method: "POST",
    url: "/v1/chat/completions",
    payload: {
      model: "gemini-3-flash-preview",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: "https://example.com/a.png" },
            },
          ],
        },
      ],
    },
  });
  assert.equal(remoteImage.statusCode, 400);
  assert.match(remoteImage.json().error.message, /data: URI/u);
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeSchemaToWire, normalizeGeminiRequest } from "../src/gateway/gemini-normalize.js";
import { buildToolsFromNames } from "../src/gateway/wire-codec.js";

describe("Gemini request normalization", () => {
  it("recognizes the imageSearch native tool key", () => {
    const result = normalizeGeminiRequest("gemini-3.8-flash", {
      contents: [{ role: "user", parts: [{ text: "find" }] }],
      tools: [{ imageSearch: {} }],
    });
    assert.deepEqual(result.tools, buildToolsFromNames(["image_search"], "gemini-3.8-flash"));
  });
  it("injects the configured default thinking level only when the request omits it", () => {
    const body = { contents: [{ role: "user", parts: [{ text: "hi" }] }] };
    const withoutDefault = normalizeGeminiRequest("gemini-3.8-flash", body);
    assert.equal(withoutDefault.generationConfig.thinkingConfig, undefined);
    const withDefault = normalizeGeminiRequest("gemini-3.8-flash", body, { thinkingLevel: "MEDIUM" });
    assert.deepEqual(withDefault.generationConfig.thinkingConfig, [1, null, null, 2]);
    const explicit = normalizeGeminiRequest("gemini-3.8-flash", {
      ...body,
      generationConfig: { thinkingConfig: { thinkingLevel: "LOW" } },
    }, { thinkingLevel: "MEDIUM" });
    assert.deepEqual(explicit.generationConfig.thinkingConfig, [1, null, null, 1]);
  });
  it("normalizes tool declarations and preserves tool turn ids", () => {
    const result = normalizeGeminiRequest("gemini-3.5-flash", {
      contents: [
        { role: "model", parts: [{ functionCall: { name: "weather", args: { city: "上海" }, id: "call_1" }, thoughtSignature: "sig" }] },
        { role: "user", parts: [{ functionResponse: { name: "weather", response: { value: 24 }, id: "call_1" } }] },
      ],
      tools: [{ functionDeclarations: [{ name: "weather", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }] }],
    });
    assert.deepEqual(result.contents[0]?.parts[0]?.functionCall, ["weather", { city: "上海" }, "call_1"]);
    assert.equal(result.contents[0]?.parts[0]?.thoughtSignature, "sig");
    assert.deepEqual(result.contents[1]?.parts[0]?.functionResponse, ["weather", { value: 24 }, "call_1"]);
    const scalar = normalizeGeminiRequest("gemini-3.5-flash", {
      contents: [{ role: "user", parts: [{ functionResponse: { name: "weather", response: "晴，23摄氏度", id: "call_1" } }] }],
    });
    assert.deepEqual(scalar.contents[0]?.parts[0]?.functionResponse, ["weather", { response: "晴，23摄氏度" }, "call_1"]);
    const functionSchema = (result.tools?.[0]?.[1] as unknown[][] | undefined)?.[0]?.[2] as unknown[] | undefined;
    assert.deepEqual(functionSchema?.[6], [["city", [1]]]);
    assert.deepEqual(functionSchema?.[22], ["city"]);
  });

  it("normalizes AI Studio built-in tools only when explicitly requested", () => {
    const withoutTools = normalizeGeminiRequest("gemini-3.5-flash", {
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
    });
    assert.equal(withoutTools.tools, null);

    const withTools = normalizeGeminiRequest("gemini-3.5-flash", {
      contents: [{ role: "user", parts: [{ text: "search" }] }],
      tools: [{ googleSearch: {} }, { codeExecution: {} }],
    });
    assert.deepEqual(withTools.tools, [
      [null, null, null, [null, [[]]]],
      [[]],
    ]);
  });

  it("enables server-side tool context circulation for Gemini 3 mixed tools", () => {
    const result = normalizeGeminiRequest("gemini-3.1-pro-preview", {
      contents: [{ role: "user", parts: [{ text: "search and call" }] }],
      tools: [
        { googleSearch: {} },
        { functionDeclarations: [{ name: "record", parameters: { type: "OBJECT" } }] },
      ],
    });
    assert.equal(result.includeServerSideToolInvocations, true);
  });

  it("encodes nested JSON schema branches", () => {
    assert.deepEqual(encodeSchemaToWire({ type: "array", items: { type: "integer" } }), [5, null, null, null, null, [3]]);
  });

  it("maps Gemini fileData URIs to AI Studio file references", () => {
    const result = normalizeGeminiRequest("gemini-3.5-flash", {
      contents: [{ role: "user", parts: [{ fileData: {
        mimeType: "application/pdf",
        fileUri: "https://generativelanguage.googleapis.com/v1beta/files/file_123",
      } }] }],
    });
    assert.deepEqual(result.contents[0]?.parts[0], { fileId: "file_123" });
  });

  it("accepts a data URI in fileData as inline media", () => {
    const result = normalizeGeminiRequest("gemini-3.5-flash", {
      contents: [{ role: "user", parts: [{ fileData: { fileUri: "data:text/plain;base64,SGk=" } }] }],
    });
    assert.deepEqual(result.contents[0]?.parts[0], { inlineData: ["text/plain", "SGk="] });
  });
  it("rejects unsupported cachedContent instead of silently ignoring it", () => {
    assert.throws(
      () => normalizeGeminiRequest("gemini-3.5-flash", {
        cachedContent: "cachedContents/example",
      }),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 400
        && JSON.stringify((error as { detail?: unknown }).detail).includes("Context Cache"),
    );
  });
});

describe("structured output and seed", () => {
  it("wire-encodes responseSchema and auto-sets JSON mime type", async () => {
    const { normalizeGeminiRequest } = await import("../src/gateway/gemini-normalize.js");
    const result = normalizeGeminiRequest("gemini-3-flash-preview", {
      contents: [{ role: "user", parts: [{ text: "列出城市" }] }],
      generationConfig: {
        responseSchema: {
          type: "object",
          properties: { city: { type: "string" }, temp: { type: "number" } },
          required: ["city"],
        },
      },
    });
    const schema = result.generationConfig.responseSchema as unknown[];
    assert.equal(schema[0], 6);
    assert.deepEqual(schema[6], [["city", [1]], ["temp", [2]]]);
    assert.deepEqual(schema[7], ["city"]);
    assert.equal(result.generationConfig.responseMimeType, "application/json");
  });

  it("passes seed through to wire generation field 18", async () => {
    const { rewriteWireBody } = await import("../src/gateway/wire-codec.js");
    const body = JSON.parse(rewriteWireBody('["models/m",[[[[null,"x"]],"user"]],null,[],"s",null,null]', {
      model: "m",
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
      generationConfig: { seed: 42 },
      sanitizePlainText: false,
    }));
    assert.equal(body[3][18], 42);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildToolsFromNames, decodeContents, encodeContent, encodePart, rewriteWireBody } from "../src/gateway/wire-codec.js";

describe("AI Studio wire codec", () => {
  it("rewrites text requests and sanitizes captured structured output", () => {
    const original = '["models/original",[[[[null,"old"]],"user"]],null,[null,["6"],null,128,0.5,0.8,16,"application/json",[6]],"snapshot",null,null]';
    const parsed = JSON.parse(rewriteWireBody(original, {
      model: "gemma-4-31b-it",
      prompt: "hello",
      snapshot: "fresh",
      maxTokens: 256,
      temperature: 0.2,
      topP: 0.9,
      topK: 32,
      previousResponseId: "v1_previous",
    })) as unknown[];
    assert.equal(parsed[0], "models/gemma-4-31b-it");
    assert.equal(parsed[11], "v1_previous");
    assert.equal((parsed[1] as unknown[][])[0]?.[1], "user");
    assert.equal((parsed[3] as unknown[])[3], 256);
    assert.equal((parsed[3] as unknown[])[7], "text/plain");
    assert.equal((parsed[3] as unknown[])[8], null);
    assert.deepEqual((parsed[3] as unknown[])[16], [1, null, null, 3]);
    assert.deepEqual(parsed[2], [7, 8, 9, 10].map(category => [null, null, category, 5]));
  });
  it("preserves captured outer continuation unless explicitly overridden", () => {
    const template = Array.from({ length: 12 }, (_, index) => index === 11 ? "captured-opaque" : null);
    const common = { model: "gemini-test", prompt: "hello", tools: [[null, []]] };
    assert.equal(JSON.parse(rewriteWireBody(JSON.stringify(template), common))[11], "captured-opaque");
    assert.equal(JSON.parse(rewriteWireBody(JSON.stringify(template), { ...common, previousResponseId: null }))[11], null);
  });

  it("preserves tool ids and thought signatures", () => {
    const content = {
      role: "model",
      parts: [{ functionCall: ["weather", { city: "上海" }, "call_1"] as const, thoughtSignature: "sig" }],
    };
    const decoded = decodeContents([encodeContent(content)]);
    assert.deepEqual(decoded[0]?.parts[0]?.functionCall, ["weather", [[["city", [null, null, "上海"]]]], "call_1"]);
    assert.equal(decoded[0]?.parts[0]?.thoughtSignature, "sig");
  });

  it("encodes function responses as protobuf Struct messages", () => {
    const encoded = encodePart({ functionResponse: ["weather", { result: { temperature: "28C" } }, "call_1"] });
    assert.deepEqual(encoded[11], [
      "weather",
      [[ ["result", [null, null, null, null, [[["temperature", [null, null, "28C"]]]]] ] ]],
      "call_1",
    ]);
    const scalar = encodePart({ functionResponse: ["weather", "晴，23摄氏度", "call_1"] });
    assert.deepEqual(scalar[11], [
      "weather",
      [[["response", [null, null, "晴，23摄氏度"]]]],
      "call_1",
    ]);
  });
  it("preserves browser built-ins with custom function declarations", () => {
    const original = '["models/original",[[[[null,"old"]],"user"]],null,[],"snapshot",null,null]';
    const custom = [null, [["weather"]]];
    const parsed = JSON.parse(rewriteWireBody(original, {
      model: "gemini-3.5-flash",
      prompt: "hello",
      tools: [buildToolsFromNames(["google_search"], "gemini-3.5-flash")[0]!, custom],
    })) as unknown[];
    assert.deepEqual(parsed[6], [buildToolsFromNames(["google_search"], "gemini-3.5-flash")[0]!, custom]);
    assert.deepEqual(parsed[13], [[null, null, "Asia/Shanghai"]]);
  });

  it("uses the image generation wire defaults", () => {
    const original = JSON.stringify(["models/original", [], [[null, null, 7, 4]], Array(27).fill(null), "snapshot", null, null]);
    const parsed = JSON.parse(rewriteWireBody(original, {
      model: "gemini-3.1-flash-image-preview",
      prompt: "draw",
      tools: buildToolsFromNames(["google_search", "image_search"], "gemini-3.1-flash-image-preview"),
    })) as unknown[];
    assert.equal(parsed[2], null);
    assert.deepEqual((parsed[3] as unknown[])[14], [2]);
    assert.deepEqual((parsed[3] as unknown[])[16], [1, null, null, 4]);
    assert.deepEqual(parsed[6], [[null, null, null, [null, [[], []]]]]);
  });

  it("does not send thinking config to image models that reject it", () => {
    const original = JSON.stringify(["models/original", [], null, Array(27).fill(null), "snapshot", null, null]);
    const parsed = JSON.parse(rewriteWireBody(original, {
      model: "gemini-2.5-flash-image",
      prompt: "draw",
      disableThinking: true,
    })) as unknown[];
    assert.equal((parsed[3] as unknown[])[16], null);
  });

  it("can force plain-text fallback without reintroducing thinking", () => {
    const original = JSON.stringify(["models/original", [], null, Array(27).fill(null), "snapshot", null, null]);
    const parsed = JSON.parse(rewriteWireBody(original, {
      model: "gemini-3.6-flash",
      prompt: "final",
      sanitizePlainText: true,
      disableThinking: true,
    })) as unknown[];
    assert.equal((parsed[3] as unknown[])[16], null);
    assert.equal((parsed[3] as unknown[])[7], null);
  });
});

describe("rewriteWireBody template validation", () => {
  it("rejects a poisoned (non-JSON) captured template with a clear error", () => {
    assert.throws(
      () => rewriteWireBody("trace=Error%2Fsomething&at=xyz", { model: "gemini-test", prompt: "hi" }),
      /不是合法 JSON/u,
    );
  });

  it("rejects a JSON non-array template", () => {
    assert.throws(
      () => rewriteWireBody('{"oops":true}', { model: "gemini-test", prompt: "hi" }),
      /must be an array/u,
    );
  });
});

describe("CountTokens wire body", () => {
  it("uses the short [model, contents] shape for plain text", async () => {
    const { encodeCountTokensBody } = await import("../src/gateway/wire-codec.js");
    const body = JSON.parse(encodeCountTokensBody({
      model: "gemini-3-flash-preview",
      contents: [{ role: "user", parts: [{ text: "北京天气" }] }],
    }));
    assert.deepEqual(body, ["models/gemini-3-flash-preview", [[[[null, "北京天气"]], "user"]]]);
  });

  it("uses the [model, null, generate] shape when tools or function parts are present", async () => {
    const { encodeCountTokensBody } = await import("../src/gateway/wire-codec.js");
    const withTools = JSON.parse(encodeCountTokensBody({
      model: "gemini-3-flash-preview",
      contents: [{ role: "user", parts: [{ text: "北京天气" }] }],
      tools: [[null, [["getWeather", "desc", [6, null, null, null, null, null, [["city", [1]]]]]]]],
    }));
    assert.equal(withTools[0], "models/gemini-3-flash-preview");
    assert.equal(withTools[1], null);
    assert.equal(withTools[2][0], "models/gemini-3-flash-preview");
    assert.deepEqual(withTools[2][1], [[[[null, "北京天气"]], "user"]]);
    assert.deepEqual(withTools[2][6], [[null, [["getWeather", "desc", [6, null, null, null, null, null, [["city", [1]]]]]]]]);

    const withFunctionPart = JSON.parse(encodeCountTokensBody({
      model: "gemini-3-flash-preview",
      contents: [
        { role: "user", parts: [{ text: "北京天气" }] },
        { role: "user", parts: [{ functionResponse: ["getWeather", { response: "1°" }, "call_1"] }] },
      ],
    }));
    assert.equal(withFunctionPart[1], null);
    assert.equal(withFunctionPart[2][1].length, 2);
  });
});

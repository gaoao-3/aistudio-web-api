import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { flattenFunctionContents, functionResponseRejected, functionResponseStalled } from "../src/gateway/native-gateway.js";

describe("native gateway tool-result fallback", () => {
  it("recognizes the AI Studio native function response rejection", () => {
    assert.equal(functionResponseRejected(400, "Invalid value (), Unexpected list for single non-message field."), true);
    assert.equal(functionResponseRejected(200, "Invalid value"), false);
  });

  it("recognizes a successful response containing only hidden thinking", () => {
    const thoughtPart = [null, "still thinking", null, null, null, null, null, null, null, null, true];
    const chunk = [[[[[thoughtPart], "model"]]], null, [1, 1, 2]];
    assert.equal(functionResponseStalled(200, JSON.stringify([[chunk]])), true);
    assert.equal(functionResponseStalled(400, JSON.stringify([[chunk]])), false);
  });

  it("preserves the whole tool timeline as textual context", () => {
    assert.deepEqual(flattenFunctionContents([
      { role: "user", parts: [{ text: "weather?" }] },
      { role: "model", parts: [{ functionCall: ["get_weather", { city: "上海" }, "call_1"] }] },
      { role: "user", parts: [{ functionResponse: ["get_weather", { temperature: "28C" }, "call_1"] }] },
    ]), [{
      role: "user",
      parts: [{ text: "weather?\n\n[assistant tool call: get_weather]\n{\"city\":\"上海\"}\n\n[tool result: get_weather]\n{\"temperature\":\"28C\"}" }],
    }]);
  });

  it("keeps media parts when flattening a timeline that mixes tools and images", () => {
    assert.deepEqual(flattenFunctionContents([
      { role: "user", parts: [{ text: "describe this" }] },
      { role: "model", parts: [{ functionCall: ["read_skill", {}, "call_1"] }] },
      { role: "user", parts: [{ functionResponse: ["read_skill", { ok: true }, "call_1"] }] },
      { role: "user", parts: [{ inlineData: ["image/png", "aGVsbG8="] }] },
    ]), [{
      role: "user",
      parts: [
        { text: "describe this\n\n[assistant tool call: read_skill]\n{}\n\n[tool result: read_skill]\n{\"ok\":true}" },
        { inlineData: ["image/png", "aGVsbG8="] },
      ],
    }]);
  });
});

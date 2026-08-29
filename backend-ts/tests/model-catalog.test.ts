import assert from "node:assert/strict";
import { it } from "node:test";
import type { NativeBrowserSession } from "../src/gateway/browser-session.js";
import { fetchModelCatalog, parseModelCatalog } from "../src/gateway/model-catalog.js";

it("parses AI Studio ListModels protobuf rows", () => {
  assert.deepEqual(parseModelCatalog([[ ["models/test-model", null, null, "Test Model", "desc", 100, 20, ["generateContent"]] ]]), [{
    name: "models/test-model",
    displayName: "Test Model",
    description: "desc",
    inputTokenLimit: 100,
    outputTokenLimit: 20,
    supportedGenerationMethods: ["generateContent"],
    defaultTemperature: undefined,
    defaultTopP: undefined,
    defaultTopK: undefined,
    thinkingLevels: undefined,
  }]);
});

it("parses generation defaults and thinking levels from live-verified slots", () => {
  const row: unknown[] = ["models/gemini-3-flash-preview", null, null, "Gemini 3 Flash Preview", "desc", 1048576, 65536, ["generateContent", "countTokens"], 1, 0.95, 64];
  row[71] = [null, null, null, 0, null, 3, [4, 1, 2, 3]];
  assert.deepEqual(parseModelCatalog([[row]]), [{
    name: "models/gemini-3-flash-preview",
    displayName: "Gemini 3 Flash Preview",
    description: "desc",
    inputTokenLimit: 1048576,
    outputTokenLimit: 65536,
    supportedGenerationMethods: ["generateContent", "countTokens"],
    defaultTemperature: 1,
    defaultTopP: 0.95,
    defaultTopK: 64,
    thinkingLevels: [4, 1, 2, 3],
  }]);
});

it("uses the API key captured from the logged-in AI Studio page", async () => {
  const session = {
    async captureTemplate() {
      return { url: "https://example.test/generate", headers: { "x-goog-api-key": "page-key" }, body: "[]" };
    },
    async cookies() {
      return [
        { name: "SAPISID", value: "sid" },
        { name: "__Secure-1PSID", value: "sid-1p" },
        { name: "__Secure-3PSID", value: "sid-3p" },
      ];
    },
    async pageFetch(url: string, headers: Readonly<Record<string, string>>, body: string) {
      assert.match(url, /MakerSuiteService\/ListModels$/u);
      assert.equal(headers["x-goog-api-key"], "page-key");
      assert.match(headers.authorization ?? "", /^SAPISIDHASH /u);
      assert.equal(body, "[]");
      return {
        status: 200,
        body: JSON.stringify([[ ["models/session-model", null, null, "Session Model", "", 10, 20, ["generateContent"]] ]]),
      };
    },
  } as unknown as NativeBrowserSession;

  const models = await fetchModelCatalog(session);
  assert.equal(models[0]?.name, "models/session-model");
});

it("validates generation config against catalog limits", async () => {
  const { validateGenerationConfig } = await import("../src/gateway/generation-limits.js");
  const model = { outputTokenLimit: 65536, thinkingLevels: [1, 2, 3] };
  const throwsWith = (fn: () => void, pattern: RegExp) => assert.throws(fn, (error: unknown) => {
    const detail = (error as { detail?: { message?: unknown } }).detail;
    return pattern.test(String(detail?.message ?? error));
  });
  validateGenerationConfig(model, { maxOutputTokens: 65536, temperature: 1, topP: 0.95, topK: 64, thinkingConfig: [1, null, null, 3] });
  throwsWith(() => validateGenerationConfig(model, { maxOutputTokens: 65537 }), /超过模型上限 65536/);
  throwsWith(() => validateGenerationConfig(model, { temperature: 2.5 }), /temperature/);
  throwsWith(() => validateGenerationConfig(model, { topP: 1.5 }), /topP/);
  throwsWith(() => validateGenerationConfig(model, { topK: -1 }), /topK/);
  throwsWith(() => validateGenerationConfig(model, { thinkingConfig: [1, null, null, 4] }), /thinkingLevel/);
  // 目录条目缺失时 fail-open，仅校验协议级范围
  validateGenerationConfig(undefined, { maxOutputTokens: 999_999_999, temperature: 2 });
  throwsWith(() => validateGenerationConfig(undefined, { temperature: 3 }), /temperature/);
});

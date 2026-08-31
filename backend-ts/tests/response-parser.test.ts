import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { projectRoot } from "../src/config.js";
import { parseAIStudioResponse, toGeminiResponse } from "../src/gateway/response-parser.js";

describe("AI Studio response parser", () => {
  it("parses the captured streaming fixture", async () => {
    const raw = await readFile(join(projectRoot, "tests", "test_output.json"), "utf8");
    const parsed = parseAIStudioResponse(raw);
    assert.equal(parsed.candidate.text, "你好！有什么我可以帮你的吗？");
    assert.match(parsed.candidate.thinking, /^The user said/u);
    assert.equal(parsed.usage.promptTokens, 5);
    assert.equal(parsed.usage.completionTokens, 161);
    assert.equal(parsed.usage.reasoningTokens, 153);
    assert.equal(parsed.usage.totalTokens, 166);
    assert.ok(parsed.responseId);
    const gemini = toGeminiResponse(parsed);
    assert.equal((gemini.usageMetadata as Record<string, unknown>).thoughtsTokenCount, 153);
  });

  it("decodes nested function arguments and preserves call metadata", () => {
    const call = ["run_code", [[["resource_filter", [null, null, [[null, null, null], [null, [["source", [null, null, "history"]]]]]]]]], "call_1"];
    const rawPart = Array(15).fill(null) as unknown[];
    rawPart[10] = call;
    rawPart[14] = "signature";
    const chunk = [[[[[rawPart], "model"]]], null, [1, 1, 2], null, null, null, null, "resp"];
    const parsed = parseAIStudioResponse(JSON.stringify([[chunk]]));
    const part = parsed.candidate.parts.find(item => "functionCall" in item)!;
    assert.deepEqual(part.functionCall, {
      name: "run_code",
      args: { resource_filter: [null, { source: "history" }] },
      id: "call_1",
    });
    assert.equal(part.thoughtSignature, "signature");
  });
  it("decodes canonical Struct object and list arguments", () => {
    const call = [
      "configure",
      [[
        ["config", [null, null, null, null, [[["mode", [null, null, "test"]]]]]],
        ["values", [null, null, null, null, null, [[[null, null, "one"], [null, null, "two"]]]]],
      ]],
      "call_1",
    ];
    const rawPart = Array(15).fill(null) as unknown[];
    rawPart[10] = call;
    const chunk = [[[[[rawPart], "model"]]], null, [1, 1, 2], null, null, null, null, "resp"];
    const parsed = parseAIStudioResponse(JSON.stringify([[chunk]]));
    const part = parsed.candidate.parts.find(item => "functionCall" in item)!;
    assert.deepEqual(part.functionCall, {
      name: "configure",
      args: { config: { mode: "test" }, values: ["one", "two"] },
      id: "call_1",
    });
  });
});

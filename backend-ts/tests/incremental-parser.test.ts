import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { projectRoot } from "../src/config.js";
import { IncrementalAIStudioParser } from "../src/gateway/incremental-parser.js";
import { parseAIStudioResponse } from "../src/gateway/response-parser.js";

describe("incremental AI Studio parser", () => {
  it("extracts complete chunks across arbitrary network boundaries", async () => {
    const raw = await readFile(join(projectRoot, "tests", "test_output.json"), "utf8");
    const parser = new IncrementalAIStudioParser();
    const chunks: unknown[][] = [];
    for (let offset = 0; offset < raw.length; offset += 37) {
      chunks.push(...parser.feed(raw.slice(offset, offset + 37)));
    }
    assert.equal(chunks.length, 10);
    const text = chunks.map(chunk => parseAIStudioResponse(JSON.stringify(chunk)).candidate.text).join("");
    const thinking = chunks.map(chunk => parseAIStudioResponse(JSON.stringify(chunk)).candidate.thinking).join("");
    assert.equal(text, "你好！有什么我可以帮你的吗？");
    assert.match(thinking, /^The user said/u);
  });

  it("does not emit a partial JSON chunk", () => {
    const parser = new IncrementalAIStudioParser();
    assert.deepEqual(parser.feed(")]}'\n[[[[1"), []);
    assert.deepEqual(parser.feed(",2,3]]]]"), [[[1, 2, 3]]]);
  });
});

it("parses AI Studio sparse JSON arrays without dropping streamed chunks", async () => {
  const { densifySparseJSON } = await import("../src/gateway/sparse-json.js");
  assert.deepEqual(JSON.parse(densifySparseJSON("[,,1,[\"a\",],\"literal [,,] text\"]")), [null, null, 1, ["a", null], "literal [,,] text"]);

  const parser = new IncrementalAIStudioParser();
  const chunks = parser.feed("[[[[,,1]]]]");
  assert.deepEqual(chunks, [[[null, null, 1]]]);
});

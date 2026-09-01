import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NativeBrowserSession } from "../src/gateway/browser-session.js";
import { NativeGateway } from "../src/gateway/native-gateway.js";

function wireResponse(finishReason?: number): string {
  const first: unknown[] = [[[[]], "model"]];
  if (finishReason !== undefined) {
    first.push(finishReason, null, null, [[null, null, 7, 1]]);
  }
  const chunk = [[first], null, [1, null, 0], null, null, null, null, "response"];
  return JSON.stringify([[chunk]]);
}

function fakeSession(responseBody: string): NativeBrowserSession {
  return {
    captureTemplate: async () => ({ url: "https://example.test/GenerateContent", headers: {}, body: "[]" }),
    generateSnapshot: async () => "",
    replay: async () => ({ status: 200, body: responseBody }),
    close: async () => undefined,
  } as unknown as NativeBrowserSession;
}

describe("native gateway terminal responses", () => {
  it("returns a safety candidate when AI Studio has no visible parts", async () => {
    const gateway = new NativeGateway(fakeSession(wireResponse(3)));
    try {
      const response = await gateway.generate("gemini-3.7-flash", {
        contents: [{ role: "user", parts: [{ text: "blocked input" }] }],
      });
      const candidate = (response.candidates as Record<string, unknown>[])[0]!;
      assert.equal(candidate.finishReason, "SAFETY");
      assert.deepEqual((candidate.content as Record<string, unknown>).parts, [{ text: "" }]);
    } finally {
      await gateway.close();
    }
  });

  it("keeps rejecting a response without content or a terminal reason", async () => {
    const gateway = new NativeGateway(fakeSession(wireResponse()));
    try {
      await assert.rejects(
        gateway.generate("gemini-3.7-flash", {
          contents: [{ role: "user", parts: [{ text: "malformed upstream response" }] }],
        }),
        /AI Studio upstream returned an empty candidate/u,
      );
    } finally {
      await gateway.close();
    }
  });
});

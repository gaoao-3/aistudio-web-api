import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isGenerateRequestUrl } from "../src/gateway/browser-session.js";

describe("AI Studio generation template capture", () => {
  it("accepts only the actual StreamGenerateContent RPC", () => {
    assert.equal(
      isGenerateRequestUrl(
        "https://aisandbox-pa.googleapis.com/$rpc/google.internal.aistudio.v1.GenerativeService/StreamGenerateContent?key=test",
      ),
      true,
    );
    assert.equal(
      isGenerateRequestUrl(
        "https://aisandbox-pa.googleapis.com/$rpc/google.internal.aistudio.v1.GenerativeService.StreamGenerateContent?key=test",
      ),
      true,
    );
    assert.equal(
      isGenerateRequestUrl(
        "https://aisandbox-pa.googleapis.com/$rpc/google.internal.aistudio.v1.GenerativeService.GenerateContent?key=test",
      ),
      true,
    );
  });

  it("rejects similarly named quota and token-count RPCs", () => {
    assert.equal(
      isGenerateRequestUrl(
        "https://aisandbox-pa.googleapis.com/$rpc/google.internal.aistudio.v1.GenerativeService/StreamGenerateContentPerUserQuota?key=test",
      ),
      false,
    );
    assert.equal(
      isGenerateRequestUrl(
        "https://aisandbox-pa.googleapis.com/$rpc/google.internal.aistudio.v1.GenerativeService.CountTokens?key=test",
      ),
      false,
    );
    assert.equal(isGenerateRequestUrl("not a URL"), false);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NativeBrowserSession } from "../src/gateway/browser-session.js";
import { NativeGateway, detectUpstreamQuota } from "../src/gateway/native-gateway.js";

function wireResponse(finishReason?: number): string {
  const first: unknown[] = [[[[]], "model"]];
  if (finishReason !== undefined) {
    first.push(finishReason, null, null, [[null, null, 7, 1]]);
  }
  const chunk = [[first], null, [1, null, 0], null, null, null, null, "response"];
  return JSON.stringify([[chunk]]);
}

function fakeSession(
  responseBody: string,
  status = 200,
  headers?: Readonly<Record<string, string>>,
): NativeBrowserSession {
  return {
    captureTemplate: async () => ({ url: "https://example.test/GenerateContent", headers: {}, body: "[]" }),
    generateSnapshot: async () => "",
    replay: async () => ({ status, ...(headers ? { headers } : {}), body: responseBody }),
    close: async () => undefined,
  } as unknown as NativeBrowserSession;
}

describe("upstream quota signals", () => {
  it("classifies quota responses and extracts retry metadata", () => {
    assert.deepEqual(
      detectUpstreamQuota(
        429,
        JSON.stringify({
          error: {
            status: "RESOURCE_EXHAUSTED",
            message: "You exceeded your current quota",
            quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests",
          },
        }),
        { "Retry-After": "7" },
      ),
      {
        reason: "quota_exceeded",
        retryAfterMs: 7000,
        quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests",
      },
    );
  });

  it("recognizes PerUserQuota routing errors without flagging ordinary 404s", () => {
    assert.deepEqual(
      detectUpstreamQuota(404, "Ambiguous request for /GenerativeService.StreamGenerateContentPerUserQuota"),
      { reason: "per_user_quota" },
    );
    assert.equal(detectUpstreamQuota(404, "Requested entity was not found."), undefined);
  });

  it("attaches quota details to upstream errors", async () => {
    const gateway = new NativeGateway(fakeSession(
      JSON.stringify({
        error: {
          status: "RESOURCE_EXHAUSTED",
          message: "quota exceeded",
          quotaMetric: "requests_per_minute",
        },
      }),
      429,
      { "Retry-After": "3" },
    ));
    try {
      await assert.rejects(
        gateway.generate("gemini-3.7-flash", {
          contents: [{ role: "user", parts: [{ text: "quota" }] }],
        }),
        (error: unknown) => {
          if (!error || typeof error !== "object" || !("statusCode" in error) || !("quotaInfo" in error)) return false;
          assert.equal(error.statusCode, 429);
          assert.deepEqual(error.quotaInfo, {
            reason: "quota_exceeded",
            retryAfterMs: 3000,
            quotaMetric: "requests_per_minute",
          });
          return true;
        },
      );
    } finally {
      await gateway.close();
    }
  });
});

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

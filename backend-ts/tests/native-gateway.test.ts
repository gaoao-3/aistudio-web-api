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

describe("native gateway tool validation", () => {
  it("rejects function declarations on image models before any upstream call", async () => {
    const gateway = new NativeGateway(fakeSession(wireResponse(3)));
    try {
      await assert.rejects(
        gateway.generate("gemini-3.1-flash-image", {
          contents: [{ role: "user", parts: [{ text: "draw" }] }],
          tools: [{ functionDeclarations: [{ name: "getWeather" }] }],
        }),
        (error: unknown) => {
          const detail = (error as { detail?: { message?: unknown } }).detail;
          return /image 生成模型不支持 function declarations/u.test(String(detail?.message ?? error));
        },
      );
    } finally {
      await gateway.close();
    }
  });

  it("rejects google_maps combined with code_execution even when the catalog is unavailable", async () => {
    // fakeSession 没有 pageFetch/cookies：models() 拉取失败 → generation 校验 fail-open，
    // 但硬规则独立于目录仍然生效。
    const gateway = new NativeGateway(fakeSession(wireResponse(3)));
    try {
      await assert.rejects(
        gateway.generate("gemini-3.8-flash", {
          contents: [{ role: "user", parts: [{ text: "where" }] }],
          tools: [{ googleMaps: {} }, { codeExecution: {} }],
        }),
        (error: unknown) => {
          const detail = (error as { detail?: { message?: unknown } }).detail;
          return /google_maps 不能与/u.test(String(detail?.message ?? error));
        },
      );
    } finally {
      await gateway.close();
    }
  });
});

describe("native gateway model catalog cache", () => {
  function catalogSession() {
    let pageFetches = 0;
    const session = {
      captureTemplate: async () => ({
        url: "https://aistudio.google.com/",
        headers: { "x-goog-api-key": "test-key" } as Readonly<Record<string, string>>,
        body: "[]" as string,
      }),
      cookies: async () => [
        { name: "SAPISID", value: "s" },
        { name: "SAPISIDHASH", value: "sh" },
        { name: "__Secure-1PSID", value: "p1" },
        { name: "SAPISID1PHASH", value: "p1h" },
        { name: "__Secure-3PSID", value: "p3" },
        { name: "SAPISID3PHASH", value: "p3h" },
      ] as { name: string; value: string }[],
      pageFetch: async () => {
        pageFetches += 1;
        return { status: 200, body: JSON.stringify([[["models/gemini-single", "", "", "Gemini Single", "desc", 1000, 2000, ["generateContent"]]]]) };
      },
      refreshAuth: async () => ({ status: "refreshed" }),
      switchAuth: async () => undefined,
      close: async () => undefined,
      warmup: async () => undefined,
    };
    return {
      session: session as unknown as NativeBrowserSession,
      pageFetches: () => pageFetches,
    };
  }

  it("coalesces concurrent catalog fetches and serves the TTL cache", async () => {
    const { session, pageFetches } = catalogSession();
    const gateway = new NativeGateway(session);
    try {
      const results = await Promise.all([gateway.models(), gateway.models(), gateway.models()]);
      assert.equal(pageFetches(), 1);
      assert.equal(results[0]![0]!.name, "models/gemini-single");
      // TTL 窗口内命中缓存，不再发 ListModels
      assert.equal((await gateway.models())[0]!.name, "models/gemini-single");
      assert.equal(pageFetches(), 1);
      // 认证刷新后目录失效，重新拉取
      await gateway.refreshAuth();
      assert.equal((await gateway.models())[0]!.name, "models/gemini-single");
      assert.equal(pageFetches(), 2);
    } finally {
      await gateway.close();
    }
  });

  it("rejects on catalog failure and allows the next call to retry", async () => {
    let fail = true;
    const { session, pageFetches } = catalogSession();
    const failing = {
      ...session,
      pageFetch: async () => {
        pageFetches();
        if (fail) return { status: 500, body: "boom" };
        return { status: 200, body: JSON.stringify([[["models/gemini-single", "", "", "Gemini Single", "desc", 1000, 2000, ["generateContent"]]]]) };
      },
    } as unknown as NativeBrowserSession;
    const gateway = new NativeGateway(failing);
    try {
      await assert.rejects(gateway.models(), /ListModels returned HTTP 500/u);
      fail = false;
      assert.equal((await gateway.models())[0]!.name, "models/gemini-single");
    } finally {
      await gateway.close();
    }
  });
});

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

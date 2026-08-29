import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NativeContinuationStore } from "../src/bridge/native-continuation.js";

describe("native continuation store", () => {
  it("matches all function responses to one response and account", () => {
    const store = new NativeContinuationStore(60_000, 10);
    const calls = [
      { name: "weather", id: "call_1" },
      { name: "calendar", id: "call_2" },
    ] as const;
    store.remember("models/gemini-test", calls, "v1_response", "account-a");

    assert.equal(store.find("gemini-test", [{ name: "weather", id: "call_1" }])?.accountId, "account-a");
    assert.equal(store.find("gemini-test", calls)?.responseId, "v1_response");
    assert.equal(store.find("gemini-other", [{ name: "weather", id: "call_1" }]), undefined);
    assert.equal(store.find("gemini-test", [{ name: "other", id: "call_1" }]), undefined);
  });

  it("does not mix entries with different continuation IDs or accounts", () => {
    const store = new NativeContinuationStore(60_000, 10);
    store.remember("gemini-test", [{ name: "weather", id: "call_1" }], "v1_one", "account-a");
    store.remember("gemini-test", [{ name: "calendar", id: "call_2" }], "v1_two", "account-b");

    assert.equal(store.find("gemini-test", [
      { name: "weather", id: "call_1" },
      { name: "calendar", id: "call_2" },
    ]), undefined);
  });

  it("expires entries and removes an account without touching others", async () => {
    const store = new NativeContinuationStore(1_000, 10);
    store.remember("gemini-test", [{ name: "weather", id: "call_1" }], "v1_one", "account-a");
    store.remember("gemini-test", [{ name: "weather", id: "call_2" }], "v1_two", "account-b");
    store.removeAccount("account-a");
    assert.equal(store.find("gemini-test", [{ name: "weather", id: "call_1" }]), undefined);
    assert.equal(store.size, 1);

    await new Promise(resolve => setTimeout(resolve, 1_100));
    assert.equal(store.size, 0);
  });

  it("consumes only the requested call IDs", () => {
    const store = new NativeContinuationStore();
    store.remember("gemini-test", [{ name: "weather", id: "call_1" }], "v1_one");
    store.remember("gemini-test", [{ name: "weather", id: "call_2" }], "v1_two");
    store.consume("gemini-test", [{ name: "weather", id: "call_1" }]);

    assert.equal(store.find("gemini-test", [{ name: "weather", id: "call_1" }]), undefined);
    assert.equal(store.find("gemini-test", [{ name: "weather", id: "call_2" }])?.responseId, "v1_two");
  });
});

import { createHash } from "node:crypto";
import { NativeBrowserSession } from "./browser-session.js";

const ORIGIN = "https://aistudio.google.com";

function signature(timestamp: number, value: string, label: string): string {
  const digest = createHash("sha1").update(`${timestamp} ${value} ${ORIGIN}`).digest("hex");
  return `${label} ${timestamp}_${digest}`;
}

function valueAt(row: unknown[], index: number, fallback: unknown): unknown {
  return row[index] ?? fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function supportsPublicModelOperations(model: unknown): model is Record<string, unknown> {
  if (!isRecord(model) || !Array.isArray(model.supportedGenerationMethods)) return isRecord(model);
  return model.supportedGenerationMethods.includes("generateContent");
}

export function filterSupportedModelCatalog(models: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return models.filter(supportsPublicModelOperations);
}

export function parseModelCatalog(payload: unknown): Record<string, unknown>[] {
  if (!Array.isArray(payload) || !Array.isArray(payload[0])) return [];
  return payload[0].flatMap(row => {
    if (!Array.isArray(row) || typeof row[0] !== "string" || !row[0]) return [];
    const name = row[0];
    const display = valueAt(row, 3, name.replace(/^models\//u, ""));
    // 现场验证（gemini-3-flash-preview）：索引 8/9/10 为默认 temperature/topP/topK，
    // 索引 71 的第 6 槽为支持的 thinking levels（Low=1, Medium=2, High=3, Minimal=4）。
    const thinking = Array.isArray(row[71]) ? (row[71] as unknown[])[6] : undefined;
    return [{
      name,
      displayName: typeof display === "string" ? display : name.replace(/^models\//u, ""),
      description: typeof row[4] === "string" ? row[4] : "",
      inputTokenLimit: typeof row[5] === "number" ? row[5] : 0,
      outputTokenLimit: typeof row[6] === "number" ? row[6] : 0,
      supportedGenerationMethods: Array.isArray(row[7]) ? row[7] : [],
      defaultTemperature: typeof row[8] === "number" ? row[8] : undefined,
      defaultTopP: typeof row[9] === "number" ? row[9] : undefined,
      defaultTopK: typeof row[10] === "number" ? row[10] : undefined,
      thinkingLevels: Array.isArray(thinking) ? thinking.filter((item): item is number => typeof item === "number") : undefined,
    }];
  });
}

const MAKER_SUITE_RPC_BASE = "https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService";

/** 使用页面 Cookie 计算 SAPISID 三段签名，发起 MakerSuite RPC（ListModels/CountTokens 等）。 */
export async function makerSuitePost(session: NativeBrowserSession, method: string, body: string): Promise<{ status: number; body: string }> {
  const template = await session.captureTemplate("model-catalog");
  const apiKey = template.headers["x-goog-api-key"];
  if (!apiKey) throw new Error("Active AI Studio browser session did not expose x-goog-api-key");
  const byName = new Map((await session.cookies()).map(cookie => [cookie.name, cookie.value]));
  const timestamp = Math.floor(Date.now() / 1000);
  const labels = [
    ["SAPISID", "SAPISIDHASH"],
    ["__Secure-1PSID", "SAPISID1PHASH"],
    ["__Secure-3PSID", "SAPISID3PHASH"],
  ] as const;
  const authorization = labels.map(([name, label]) => {
    const value = byName.get(name);
    if (!value) throw new Error(`Active browser session is missing ${name}`);
    return signature(timestamp, value, label);
  }).join(" ");
  return session.pageFetch(`${MAKER_SUITE_RPC_BASE}/${method}`, {
    "content-type": "application/json+protobuf",
    authorization,
    "x-user-agent": "grpc-web-javascript/0.1",
    "x-goog-api-key": apiKey,
    "x-goog-authuser": "0",
  }, body);
}

export async function fetchModelCatalog(session: NativeBrowserSession): Promise<Record<string, unknown>[]> {
  const response = await makerSuitePost(session, "ListModels", "[]");
  if (response.status !== 200) throw new Error(`ListModels returned HTTP ${response.status}`);
  return parseModelCatalog(JSON.parse(response.body));
}

/** CountTokens：响应为单元素数组，索引 0 是权威输入 token 数。 */
export async function fetchCountTokens(session: NativeBrowserSession, body: string): Promise<number> {
  const response = await makerSuitePost(session, "CountTokens", body);
  if (response.status !== 200) {
    throw Object.assign(
      new Error(`CountTokens returned HTTP ${response.status}: ${response.body.slice(0, 300)}`),
      { statusCode: response.status },
    );
  }
  const root = JSON.parse(response.body) as unknown;
  const total = Array.isArray(root) ? Number(root[0]) : NaN;
  if (!Number.isFinite(total) || total < 0) throw new Error(`CountTokens response missing token total: ${response.body.slice(0, 200)}`);
  return total;
}

export type ProtocolEvidenceStatus = "verified" | "unverified";

export interface ProtocolCapability {
  readonly status: ProtocolEvidenceStatus;
  readonly evidence: readonly string[];
  readonly notes: string;
}

/**
 * 私有协议能力必须有抓包或真实冒烟证据。新增 wire 字段时先登记为 unverified；
 * 只有真实 AI Studio 请求成功后才能改为 verified，禁止依靠猜测悄悄发送。
 */
export const PROTOCOL_CAPABILITIES = {
  generateContent: {
    status: "verified",
    evidence: ["scripts/native-protocol-smoke.ts"],
    notes: "MakerSuiteService/GenerateContent text and streaming wire",
  },
  countTokens: {
    status: "verified",
    evidence: ["scripts/native-protocol-smoke.ts", "tests/wire-codec.test.ts"],
    notes: "MakerSuiteService/CountTokens short and full request shapes",
  },
  functionCalling: {
    status: "verified",
    evidence: [
      "scripts/native-protocol-smoke.ts",
      "scripts/capture-function-tool.ts",
    ],
    notes:
      "Native functionCall/functionResponse, call id, thought signature and responseId continuation",
  },
  structuredOutput: {
    status: "verified",
    evidence: [
      "scripts/native-protocol-smoke.ts",
      "tests/gemini-normalize.test.ts",
    ],
    notes:
      "Wire-encoded responseSchema with application/json response MIME type",
  },
  driveUpload: {
    status: "unverified",
    evidence: [],
    notes:
      "GenerateAccessToken and Drive multipart chain have not been captured in this project",
  },
  veo: {
    status: "unverified",
    evidence: [],
    notes: "Video operation RPCs have not been captured in this project",
  },
  speechGeneration: {
    status: "unverified",
    evidence: [],
    notes:
      "Speech configuration wire has not been verified against a live response",
  },
} as const satisfies Record<string, ProtocolCapability>;

export type ProtocolCapabilityName = keyof typeof PROTOCOL_CAPABILITIES;

export function assertProtocolCapability(name: ProtocolCapabilityName): void {
  const capability = PROTOCOL_CAPABILITIES[name];
  if (capability.status !== "verified") {
    throw new Error(
      `AI Studio private protocol capability '${name}' is unverified; refusing to guess its wire encoding`,
    );
  }
}

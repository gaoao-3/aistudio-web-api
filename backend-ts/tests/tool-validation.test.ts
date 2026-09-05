import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  builtinToolNames,
  validateHardToolRules,
  validateRequestedTools,
} from "../src/gateway/tool-validation.js";

function throwsWith(fn: () => void, pattern: RegExp): void {
  assert.throws(fn, (error: unknown) => {
    const detail = (error as { detail?: { message?: unknown } }).detail;
    return pattern.test(String(detail?.message ?? error));
  });
}

const FUNCTION_TOOLS = [{ functionDeclarations: [{ name: "getWeather" }] }];
const SEARCH_TOOL = [{ googleSearch: {} }];
const MAPS_TOOL = [{ googleMaps: {} }];
const CODE_TOOL = [{ codeExecution: {} }];
const URL_TOOL = [{ urlContext: {} }];

describe("builtin tool name extraction", () => {
  it("recognizes native tool keys including aliases", () => {
    assert.deepEqual(
      [...builtinToolNames([{ googleSearchRetrieval: {} }, { codeExecution: {} }])].sort(),
      ["code_execution", "google_search"],
    );
    assert.deepEqual(
      [...builtinToolNames([{ googleSearch: {} }, { googleMaps: {} }, { urlContext: {} }])].sort(),
      ["google_maps", "google_search", "url_context"],
    );
    assert.deepEqual(
      [...builtinToolNames([{ imageSearch: {} }, { googleSearchRetrieval: {} }])].sort(),
      ["google_search", "image_search"],
    );
    // 非对象 / 未知键不识别
    assert.equal(builtinToolNames([null, "x", { unknown: {} }]).size, 0);
  });
});

describe("hard tool rules (no catalog required)", () => {
  it("passes when no tools are present", () => {
    validateHardToolRules("models/gemini-3.8-flash", undefined);
    validateHardToolRules("models/gemini-3.8-flash", []);
  });

  it("rejects google_maps combined with code_execution or url_context", () => {
    throwsWith(
      () => validateHardToolRules("models/gemini-3.8-flash", [...MAPS_TOOL, ...CODE_TOOL]),
      /google_maps 不能与 code_execution/u,
    );
    throwsWith(
      () => validateHardToolRules("models/gemini-3.8-flash", [...MAPS_TOOL, ...URL_TOOL]),
      /google_maps 不能与/u,
    );
    // maps + search 是允许的组合
    validateHardToolRules("models/gemini-3.8-flash", [...MAPS_TOOL, ...SEARCH_TOOL]);
  });

  it("rejects function declarations on image generation models", () => {
    for (const model of ["gemini-3.1-flash-image", "gemini-3-pro-image", "gemini-2.5-flash-image"]) {
      throwsWith(
        () => validateHardToolRules(`models/${model}`, FUNCTION_TOOLS),
        /image 生成模型不支持 function declarations/u,
      );
    }
    // image 模型的搜索类内置工具不受影响
    validateHardToolRules("models/gemini-3.1-flash-image", SEARCH_TOOL);
    // 非 image 模型函数声明放行
    validateHardToolRules("models/gemini-3.8-flash", FUNCTION_TOOLS);
  });
});

describe("catalog capability rules", () => {
  const capabilities = {
    function_declarations: true,
    google_search: true,
    code_execution: true,
    google_maps: false,
    url_context: true,
  };

  it("enforces declared capabilities when the catalog entry has them", () => {
    const model = { capabilities };
    // 满足能力
    validateRequestedTools(model, "models/gemini-3.8-flash", [...FUNCTION_TOOLS, ...SEARCH_TOOL]);
    // 缺能力
    throwsWith(
      () => validateRequestedTools(model, "models/gemini-3.8-flash", MAPS_TOOL),
      /模型 models\/gemini-3\.8-flash 不支持：内置工具 google_maps/u,
    );
    // capabilities 缺失函数声明能力时拒绝函数工具
    throwsWith(
      () => validateRequestedTools({ capabilities: { google_search: true } }, "models/gemini-2.5-flash", FUNCTION_TOOLS),
      /不支持：function declarations/u,
    );
  });

  it("fails open when the catalog entry has no capabilities record", () => {
    // 无 capabilities 字段：只执行硬规则（无冲突 → 放行）
    validateRequestedTools({ name: "models/gemini-3.8-flash" }, "models/gemini-3.8-flash", [
      ...FUNCTION_TOOLS,
      ...MAPS_TOOL,
      ...SEARCH_TOOL,
    ]);
    // 目录不可用（undefined）：同样放行
    validateRequestedTools(undefined, "models/gemini-3.8-flash", FUNCTION_TOOLS);
  });

  it("still applies hard rules when capabilities pass", () => {
    const model = { capabilities };
    throwsWith(
      () => validateRequestedTools(model, "models/gemini-3.8-flash", [...MAPS_TOOL, ...CODE_TOOL]),
      /google_maps 不能与/u,
    );
    throwsWith(
      () => validateRequestedTools(model, "models/gemini-3.1-flash-image", FUNCTION_TOOLS),
      /image 生成模型不支持/u,
    );
  });
});
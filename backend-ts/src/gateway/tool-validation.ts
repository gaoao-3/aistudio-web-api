import { HttpError } from "../http/errors.js";

/**
 * 模型 × 工具能力校验（参考 AIStudio2API 的 tool_validation）。
 *
 * 三层规则，全部 fail-open 于未知信息：
 * 1. 硬规则（不依赖模型目录）：内置工具组合冲突（google_maps 与
 *    code_execution / url_context 互斥，AI Studio 页面工具面板同样互斥）；
 *    image 生成模型不支持函数声明。
 * 2. 目录能力（model 条目带 capabilities 记录时）：函数声明需要
 *    function_declarations；内置工具需要同名能力（url_context 记作
 *    url_context）。目录无 capabilities 字段时跳过，不阻塞请求。
 * 3. 模型名硬类别（image 模型仅允许搜索类内置工具，wire 编码层已有
 *    同名校验，此处对函数声明补同一语义）。
 */

const BUILTIN_KEYS = {
  code_execution: ["codeExecution"] as ReadonlyArray<string>,
  google_search: ["googleSearch", "googleSearchRetrieval"] as ReadonlyArray<string>,
  image_search: ["imageSearch"] as ReadonlyArray<string>,
  google_maps: ["googleMaps"] as ReadonlyArray<string>,
  url_context: ["urlContext"] as ReadonlyArray<string>,
} as const;

type BuiltinName = keyof typeof BUILTIN_KEYS;

/** 从协议形状的 tools 数组提取内置工具名集合（与 normalize 的识别规则一致）。 */
export function builtinToolNames(tools: unknown): Set<BuiltinName> {
  const names = new Set<BuiltinName>();
  if (!Array.isArray(tools)) return names;
  for (const rawTool of tools) {
    if (!rawTool || typeof rawTool !== "object" || Array.isArray(rawTool)) continue;
    for (const [name, keys] of Object.entries(BUILTIN_KEYS)) {
      for (const key of keys) {
        if (key in (rawTool as Record<string, unknown>)) names.add(name as BuiltinName);
      }
    }
  }
  return names;
}

function hasFunctionDeclarations(tools: unknown): boolean {
  if (!Array.isArray(tools)) return false;
  return tools.some((rawTool) => (
    rawTool !== null
    && typeof rawTool === "object"
    && !Array.isArray(rawTool)
    && Array.isArray((rawTool as Record<string, unknown>).functionDeclarations)
    && ((rawTool as Record<string, unknown>).functionDeclarations as unknown[]).length > 0
  ));
}

function isImageModel(modelName: string): boolean {
  return modelName.replace(/^models\//u, "").toLowerCase().includes("image");
}

function bad(message: string): never {
  throw new HttpError(400, { message, type: "invalid_request_error" });
}

/** 不依赖模型目录的硬规则：内置工具组合与模型类别限制。 */
export function validateHardToolRules(modelName: string, tools: unknown): void {
  if (!Array.isArray(tools) || tools.length === 0) return;
  const builtins = builtinToolNames(tools);
  if (builtins.has("google_maps") && (builtins.has("code_execution") || builtins.has("url_context"))) {
    bad("google_maps 不能与 code_execution / url_context 同时使用（AI Studio 不支持该工具组合）");
  }
  if (isImageModel(modelName) && hasFunctionDeclarations(tools)) {
    bad("image 生成模型不支持 function declarations（请移除 tools 中的函数声明）");
  }
}

/**
 * 模型 × 工具能力校验。model 为 undefined（目录不可用）时只执行硬规则；
 * model.capabilities 为 record 时按能力放行/拒绝，缺记录则跳过能力检查。
 */
export function validateRequestedTools(
  model: Record<string, unknown> | undefined,
  modelName: string,
  tools: unknown,
): void {
  validateHardToolRules(modelName, tools);
  if (!Array.isArray(tools) || tools.length === 0) return;
  const capabilities = isRecord(model?.capabilities) ? model.capabilities : undefined;
  if (!capabilities) return; // 目录无能力记录：fail-open

  const missing = (name: string, label: string): never => {
    bad(`模型 ${modelName} 不支持：${label}`);
  };
  if (hasFunctionDeclarations(tools) && capabilities.function_declarations !== true) {
    missing("function_declarations", "function declarations");
  }
  for (const name of builtinToolNames(tools)) {
    if (capabilities[name] !== true) missing(name, `内置工具 ${name}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
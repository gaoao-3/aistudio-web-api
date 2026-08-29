import { HttpError } from "../http/errors.js";

/**
 * 基于 ListModels 实时目录的 generation 参数校验（参考 AIStudio2API 的
 * GenerationDefaults）。目录条目缺失时 fail-open：范围类硬规则（Gemini 协议
 * 本身约束）始终校验，模型相关规则（输出上限、thinking levels）仅在校验
 * 目录已知时生效。
 */
export function validateGenerationConfig(
  model: Record<string, unknown> | undefined,
  config: Record<string, unknown>,
): void {
  const bad = (message: string): never => {
    throw new HttpError(400, { message, type: "invalid_request_error" });
  };

  if (config.maxOutputTokens !== undefined) {
    const value = Number(config.maxOutputTokens);
    if (!Number.isInteger(value) || value <= 0)
      bad("maxOutputTokens 必须是正整数");
    const limit =
      typeof model?.outputTokenLimit === "number" ? model.outputTokenLimit : 0;
    if (limit > 0 && value > limit)
      bad(`maxOutputTokens ${value} 超过模型上限 ${limit}`);
  }
  if (config.temperature !== undefined) {
    const value = Number(config.temperature);
    if (!Number.isFinite(value) || value < 0 || value > 2)
      bad("temperature 必须在 0 到 2 之间");
  }
  if (config.topP !== undefined) {
    const value = Number(config.topP);
    if (!Number.isFinite(value) || value < 0 || value > 1)
      bad("topP 必须在 0 到 1 之间");
  }
  if (config.topK !== undefined) {
    const value = Number(config.topK);
    if (!Number.isInteger(value) || value < 0) bad("topK 必须是非负整数");
  }

  // normalizeThinking 已把 thinkingConfig 归一为 [mode, null, null, level]
  const thinking = config.thinkingConfig;
  const levels = Array.isArray(model?.thinkingLevels)
    ? model.thinkingLevels.filter(
        (item): item is number => typeof item === "number",
      )
    : [];
  if (
    Array.isArray(thinking) &&
    typeof thinking[3] === "number" &&
    levels.length > 0 &&
    !levels.includes(thinking[3])
  ) {
    const names: Readonly<Record<number, string>> = {
      1: "LOW",
      2: "MEDIUM",
      3: "HIGH",
      4: "MINIMAL",
    };
    bad(
      `模型不支持 thinkingLevel ${names[thinking[3]] ?? thinking[3]}（支持：${levels.map((level) => names[level] ?? level).join("/")}）`,
    );
  }
}

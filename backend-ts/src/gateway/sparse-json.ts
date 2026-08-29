/**
 * AI Studio 的 JSON+protobuf 响应使用稀疏数组语法：连续逗号表示省略的 null，
 * 例如 `[,,1]` 等价于 `[null,null,1]`，`["a",]` 等价于 `["a",null]`。
 * 标准 JSON.parse 拒绝这种写法；这里在解析前把它归一化为合法 JSON。
 * 字符串字面量内的逗号和括号不受影响。
 *
 * 参考 AIStudio2API 的 sparseJSONReader（生产现场证据）。
 */
export function densifySparseJSON(source: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  let previousToken = "";
  for (const ch of source) {
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      previousToken = '"';
      out += ch;
      continue;
    }
    if (ch === "," && (previousToken === "[" || previousToken === ",")) {
      previousToken = ",";
      out += "null,";
      continue;
    }
    if (ch === "]" && previousToken === ",") {
      previousToken = "]";
      out += "null]";
      continue;
    }
    if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r")
      previousToken = ch;
    out += ch;
  }
  return out;
}

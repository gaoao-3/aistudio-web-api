// ---------- 通用小工具 ----------
export function fmtDate(s?: string): string {
  if (!s) return '-';
  try { return new Date(s).toLocaleString(); } catch (e) { return s; }
}

/** 大数字缩写：1234 -> 1.2K，1234567 -> 1.2M */
export function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

/** 精确显示整数，不做 K/M 缩写：1234567 -> 1,234,567 */
export function fmtExactNum(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return Math.round(n).toLocaleString('en-US');
}

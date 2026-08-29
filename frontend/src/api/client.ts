// ---------- API 访问层（从 app.ts 的 authHeaders/apiFetch 移植） ----------
import { useToast } from '../composables/useToast';

// 全局消息提示（不依赖组件上下文，composable 与视图中统一使用）
const toast = useToast();

export function toastOk(msg: string) { toast.ok(msg); }
export function toastErr(msg: string) { toast.err(msg); }
export function toastInfo(msg: string) { toast.info(msg); }

export function authHeaders(headers: Record<string, string> = {}): Record<string, string> {
  const next = { ...headers };
  // Native built-in tools are a WebUI-only capability. API keys still
  // authenticate the request, but they no longer carry a tool permission.
  if (!next['X-AIStudio-WebUI'] && !next['x-aistudio-webui']) next['X-AIStudio-WebUI'] = '1';
  const token = (localStorage.getItem('asp_api_token') || '').trim();
  if (token && !next.Authorization && !next.authorization) next.Authorization = `Bearer ${token}`;
  return next;
}

export async function apiFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, { ...options, headers: authHeaders((options.headers || {}) as Record<string, string>) });
  if (res.status === 401) toastErr('鉴权失败，请检查 API Token');
  return res;
}

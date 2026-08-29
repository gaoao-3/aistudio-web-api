// ---------- 请求日志（单次 API 调用明细，参考 new-api 日志页） ----------
import { ref } from "vue";
import { apiFetch } from "../api/client";
import type { RequestLog } from "../types";

const logs = ref<RequestLog[]>([]);
const loading = ref(false);
const error = ref("");
const lastLoadedAt = ref<Date | null>(null);

export function useLogs() {
  async function loadLogs(limit = 100): Promise<void> {
    if (loading.value) return;
    loading.value = true;
    error.value = "";
    try {
      const r = await apiFetch(`/logs?limit=${limit}`);
      if (!r.ok) throw new Error(`logs request failed: ${r.status}`);
      logs.value = (await r.json()) as RequestLog[];
      lastLoadedAt.value = new Date();
    } catch (e) {
      error.value = "请求日志暂时无法加载，请稍后重试。";
    } finally {
      loading.value = false;
    }
  }

  return { logs, loading, error, lastLoadedAt, loadLogs };
}

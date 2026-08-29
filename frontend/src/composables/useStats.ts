// ---------- 用量统计（汇总 + 按天趋势） ----------
import { computed, ref } from 'vue';
import { apiFetch } from '../api/client';
import type { CacheStats, DailyUsage, Stats } from '../types';

const stats = ref<Stats>({});
const daily = ref<DailyUsage>({});
const cache = ref<CacheStats | null>(null);
const loading = ref(false);
const error = ref('');
const lastLoadedAt = ref<Date | null>(null);

export interface TrendDay {
  date: string;
  prompt: number;
  completion: number;
  total: number;
  requests: number;
  modelCount: number;
}

export interface DailySummary extends TrendDay {
  average: number;
}

/** 兼容旧数据中同一模型同时带/不带 models/ 前缀的情况。 */
function normalizeStats(source: Stats): Stats {
  const normalized: Stats = {};
  for (const [rawName, value] of Object.entries(source)) {
    const name = rawName.replace(/^models\//u, '').trim();
    if (!name) continue;
    const existing = normalized[name] || {};
    const existingDate = existing.last_used ? Date.parse(existing.last_used) : 0;
    const valueDate = value.last_used ? Date.parse(value.last_used) : 0;
    normalized[name] = {
      requests: (existing.requests || 0) + (value.requests || 0),
      success: (existing.success || 0) + (value.success || 0),
      rate_limited: (existing.rate_limited || 0) + (value.rate_limited || 0),
      errors: (existing.errors || 0) + (value.errors || 0),
      prompt_tokens: (existing.prompt_tokens || 0) + (value.prompt_tokens || 0),
      completion_tokens: (existing.completion_tokens || 0) + (value.completion_tokens || 0),
      total_tokens: (existing.total_tokens || 0) + (value.total_tokens || 0),
      last_used: valueDate > existingDate ? value.last_used : existing.last_used,
    };
  }
  return normalized;
}

/** 取 UTC 最近 n 天的日期序列（升序） */
function lastNDays(n: number): string[] {
  const days: string[] = [];
  const now = Date.now();
  for (let i = n - 1; i >= 0; i--) {
    days.push(new Date(now - i * 86400000).toISOString().slice(0, 10));
  }
  return days;
}

export function useStats() {
  async function loadStats(): Promise<void> {
    if (loading.value) return;
    loading.value = true;
    error.value = '';
    try {
      const r = await apiFetch('/stats');
      if (!r.ok) throw new Error(`stats request failed: ${r.status}`);
      const d = await r.json() as { models?: Stats; daily?: DailyUsage; cache?: CacheStats };
      stats.value = normalizeStats(d.models || {});
      daily.value = d.daily || {};
      cache.value = d.cache ?? null;
      lastLoadedAt.value = new Date();
    } catch (e) {
      error.value = '统计数据暂时无法加载，请稍后重试。';
    } finally {
      loading.value = false;
    }
  }

  const totalReqs = computed(() => Object.values(stats.value).reduce((s, v) => s + (v.requests || 0), 0));
  const totalSuccess = computed(() => Object.values(stats.value).reduce((s, v) => s + (v.success || 0), 0));
  const totalRL = computed(() => Object.values(stats.value).reduce((s, v) => s + (v.rate_limited || 0), 0));
  const totalErrors = computed(() => Object.values(stats.value).reduce((s, v) => s + (v.errors || 0), 0));
  const totalPromptTokens = computed(() => Object.values(stats.value).reduce((s, v) => s + (v.prompt_tokens || 0), 0));
  const totalCompletionTokens = computed(() => Object.values(stats.value).reduce((s, v) => s + (v.completion_tokens || 0), 0));
  const totalTokens = computed(() => Object.values(stats.value).reduce((s, v) => s + (v.total_tokens || 0), 0));
  const successRate = computed(() => {
    const total = totalReqs.value;
    if (!total) return '-';
    return Math.round(totalSuccess.value / total * 100) + '%';
  });

  const averageTokensPerRequest = computed(() =>
    totalReqs.value > 0 ? Math.round(totalTokens.value / totalReqs.value) : 0,
  );

  const activeDays = computed(() => Object.values(daily.value).filter(bucket =>
    Object.values(bucket).some(value => (value.requests || 0) > 0 || (value.total_tokens || 0) > 0),
  ).length);

  function summarizeDay(date: string): DailySummary {
    const bucket = daily.value[date] || {};
    let prompt = 0;
    let completion = 0;
    let total = 0;
    let requests = 0;
    let modelCount = 0;
    for (const value of Object.values(bucket)) {
      const hasUsage = (value.requests || 0) > 0 || (value.total_tokens || 0) > 0;
      if (hasUsage) modelCount += 1;
      requests += value.requests || 0;
      prompt += value.prompt_tokens || 0;
      completion += value.completion_tokens || 0;
      total += value.total_tokens || 0;
    }
    return {
      date,
      prompt,
      completion,
      total,
      requests,
      modelCount,
      average: requests > 0 ? Math.round(total / requests) : 0,
    };
  }

  const todaySummary = computed(() => summarizeDay(new Date().toISOString().slice(0, 10)));
  const todayTokens = computed(() => todaySummary.value.total);
  const todayRequests = computed(() => todaySummary.value.requests);

  /** 近 n 天每日汇总（缺失日期补 0） */
  function dailySummary(n: number): DailySummary[] {
    return lastNDays(n).map(summarizeDay);
  }

  /** 近 n 天趋势（缺失日期补 0） */
  function trendDays(n: number): TrendDay[] {
    return dailySummary(n).map(({ date, prompt, completion, total, requests, modelCount }) => ({
      date,
      prompt,
      completion,
      total,
      requests,
      modelCount,
    }));
  }

  /** 模型 token 占比（降序） */
  const modelShare = computed(() =>
    Object.entries(stats.value)
      .map(([name, s]) => ({ name: name.replace('models/', ''), value: s.total_tokens || 0 }))
      .filter(m => m.value > 0)
      .sort((a, b) => b.value - a.value),
  );

  return {
    stats,
    daily,
    cache,
    loading,
    error,
    lastLoadedAt,
    loadStats,
    totalReqs,
    totalSuccess,
    totalRL,
    totalErrors,
    totalPromptTokens,
    totalCompletionTokens,
    totalTokens,
    successRate,
    averageTokensPerRequest,
    activeDays,
    todaySummary,
    todayTokens,
    todayRequests,
    dailySummary,
    trendDays,
    modelShare,
  };
}

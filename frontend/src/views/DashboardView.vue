<script setup lang="ts">
// 用量统计页：概览 + 趋势/模型分布 + 响应式模型明细
import { computed, onMounted, ref } from 'vue';
import Icon from '../components/Icon.vue';
import { useStats, type DailySummary, type TrendDay } from '../composables/useStats';
import { useLogs } from '../composables/useLogs';
import { useEChart, cssVar } from '../composables/useEChart';
import { useCountUp } from '../composables/useCountUp';
import { fmtDate, fmtExactNum, fmtNum } from '../utils';

const {
  stats,
  cache,
  loadStats,
  loading,
  error,
  lastLoadedAt,
  totalReqs,
  totalSuccess,
  totalRL,
  totalErrors,
  totalPromptTokens,
  totalCompletionTokens,
  totalTokens,
  averageTokensPerRequest,
  activeDays,
  todaySummary,
  todayTokens,
  todayRequests,
  dailySummary,
  trendDays,
  modelShare,
} = useStats();

onMounted(loadStats);

const { logs: requestLogs, loading: logsLoading, error: logsError, loadLogs } = useLogs();
onMounted(() => loadLogs());

// 日志默认只展示少量，避免刷屏；点击“显示更多”逐步展开
const LOG_PAGE = 10;
const logDisplayCount = ref(LOG_PAGE);
const visibleLogs = computed(() => requestLogs.value.slice(0, logDisplayCount.value));
const hasMoreLogs = computed(() => requestLogs.value.length > logDisplayCount.value);
function showMoreLogs(): void { logDisplayCount.value += LOG_PAGE * 2; }

// 移动端紧凑行：点击展开/收起详情
const expandedKeys = ref<Set<string>>(new Set());
function toggleExpanded(key: string): void {
  const next = new Set(expandedKeys.value);
  if (next.has(key)) next.delete(key); else next.add(key);
  expandedKeys.value = next;
}
function isExpanded(key: string): boolean { return expandedKeys.value.has(key); }

// 明细区块折叠：窄屏（手机）默认收起，点标题栏展开/收起
const startCollapsed = typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches;
const collapsedSections = ref({ models: startCollapsed, daily: startCollapsed, logs: startCollapsed });
function toggleSection(key: 'models' | 'daily' | 'logs'): void { collapsedSections.value[key] = !collapsedSections.value[key]; }

function logTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function logFullTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function logStatusText(status: string): string {
  return status === 'success' ? '成功' : status === 'rate_limited' ? '限流' : '失败';
}

function logStatusClass(status: string): string {
  return status === 'success' ? 'chip-success' : status === 'rate_limited' ? 'chip-warning' : 'chip-danger';
}

function logCacheText(cache: string): string {
  return cache === 'hit' ? '命中' : cache === 'dedup' ? '去重' : cache === 'bypass' ? '绕过' : '未中';
}

// 命中/去重的 token 来自缓存响应，仅供展示（不计入用量统计）
function isCachedLog(log: { cache: string }): boolean { return log.cache === 'hit' || log.cache === 'dedup'; }

function logLatency(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function logShortError(error: string): string {
  return error.length > 32 ? `${error.slice(0, 32)}…` : error;
}

const range = ref<7 | 30>(7);
const rangeOptions: Array<7 | 30> = [7, 30];

const modelCount = computed(() => Object.keys(stats.value).length);
const totalFailures = computed(() => totalErrors.value + totalRL.value);
const rangeLabel = computed(() => `近 ${range.value} 天`);
const hasStats = computed(() => modelCount.value > 0);

// 数字滚动动画（数据加载/刷新时平滑过渡）
const animatedTotalTokens = useCountUp(totalTokens);
const animatedTodayTokens = useCountUp(todayTokens);
const animatedTotalReqs = useCountUp(totalReqs);
const animatedPromptTokens = useCountUp(totalPromptTokens);
const animatedCompletionTokens = useCountUp(totalCompletionTokens);
const animatedAvgTokens = useCountUp(averageTokensPerRequest);
const animatedFailures = useCountUp(totalFailures);
const successRateNum = computed(() => totalReqs.value > 0 ? Math.round(totalSuccess.value / totalReqs.value * 100) : -1);
const animatedSuccessRate = useCountUp(computed(() => Math.max(successRateNum.value, 0)));
const trendData = computed(() => trendDays(range.value));
const hasTrendData = computed(() => trendData.value.some(day => day.total > 0 || day.requests > 0));
const dailyRows = computed<DailySummary[]>(() =>
  dailySummary(range.value)
    .filter(day => day.total > 0 || day.requests > 0)
    .reverse(),
);

const trendSummary = computed(() => {
  const days = trendData.value;
  const total = days.reduce((sum, day) => sum + day.total, 0);
  const requests = days.reduce((sum, day) => sum + day.requests, 0);
  const peak = days.reduce((best, day) => day.total > best.total ? day : best, days[0] as TrendDay);
  return {
    total,
    requests,
    average: Math.round(total / Math.max(days.length, 1)),
    requestAverage: Math.round(requests / Math.max(days.length, 1)),
    peak,
  };
});

const cacheHitRatePct = computed(() => cache.value ? Math.round(cache.value.hitRate * 100) : -1);
const animatedCacheHitRate = useCountUp(computed(() => Math.max(cacheHitRatePct.value, 0)));

const overviewItems = computed(() => [
  { label: '总请求', value: fmtNum(animatedTotalReqs.value), note: `成功 ${fmtNum(totalSuccess.value)}`, tone: 'primary' },
  { label: '成功率', value: successRateNum.value >= 0 ? `${animatedSuccessRate.value}%` : '-', note: totalReqs.value ? '按全部请求计算' : '等待请求记录', tone: 'ok' },
  { label: '输入 Tokens', value: fmtExactNum(animatedPromptTokens.value), note: `累计输入占 ${totalTokens.value ? Math.round(totalPromptTokens.value / totalTokens.value * 100) : 0}%`, tone: 'blue' },
  { label: '输出 Tokens', value: fmtExactNum(animatedCompletionTokens.value), note: `累计输出占 ${totalTokens.value ? Math.round(totalCompletionTokens.value / totalTokens.value * 100) : 0}%`, tone: 'purple' },
  { label: '平均 Tokens / 请求', value: fmtExactNum(animatedAvgTokens.value), note: todayRequests.value ? `今日平均 ${fmtExactNum(todaySummary.value.average)}` : '等待请求记录', tone: 'primary' },
  { label: '错误 / 限流', value: fmtNum(animatedFailures.value), note: `${fmtNum(totalErrors.value)} 错误 · ${fmtNum(totalRL.value)} 限流`, tone: 'danger' },
  cache.value && cache.value.enabled
    ? { label: '缓存命中率', value: `${animatedCacheHitRate.value}%`, note: `命中 ${fmtNum(cache.value.hits)} · 未中 ${fmtNum(cache.value.misses)} · 缓存 ${fmtNum(cache.value.entries)} 条${cache.value.skippedStores ? ` · 过大跳过 ${fmtNum(cache.value.skippedStores)}` : ''}${cache.value.dedupedHits ? ` · 去重 ${fmtNum(cache.value.dedupedHits)}` : ''}`, tone: 'ok' }
    : { label: '缓存命中率', value: '-', note: '响应缓存未启用', tone: 'muted' },
]);

function shortDate(date?: string): string {
  if (!date) return '-';
  const [, month, day] = date.split('-');
  return month && day ? `${Number(month)}月${Number(day)}日` : date;
}

function chooseRange(value: 7 | 30): void {
  range.value = value;
}

// ----- 每日 token 趋势（输入/输出堆叠柱状） -----
const trendEl = useEChart(() => {
  const days = trendData.value;
  const hasData = hasTrendData.value;
  const primary = cssVar('--primary', '#18181b');
  const accent = cssVar('--accent-3', '#d4d4d8');
  const requestColor = cssVar('--ok', '#16a34a');
  return {
    animationDuration: 420,
    tooltip: hasData ? { trigger: 'axis', axisPointer: { type: 'shadow' } } : { show: false },
    grid: { left: 8, right: 8, top: 12, bottom: 8, containLabel: true },
    xAxis: {
      type: 'category',
      data: days.map(d => d.date.slice(5)),
      axisLine: { lineStyle: { color: cssVar('--border', '#e4e4e7') } },
      axisTick: { show: false },
      axisLabel: {
        color: cssVar('--muted', '#a1a1aa'),
        fontSize: 11,
        interval: range.value === 30 ? 4 : 0,
      },
    },
    yAxis: [
      {
        type: 'value',
        min: 0,
        splitNumber: 4,
        splitLine: { lineStyle: { color: cssVar('--border-soft', 'rgba(76,63,117,0.09)') } },
        axisLabel: { color: cssVar('--muted', '#a1a1aa'), fontSize: 11, formatter: (v: number) => fmtNum(v) },
      },
      {
        type: 'value',
        min: 0,
        splitNumber: 4,
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { color: cssVar('--muted', '#a1a1aa'), fontSize: 10, formatter: (v: number) => `${fmtNum(v)}次` },
      },
    ],
    series: [
      {
        name: '输入 Tokens',
        type: 'bar',
        stack: 'tokens',
        data: days.map(d => d.prompt),
        itemStyle: { color: primary, borderRadius: [0, 0, 0, 0] },
        barMaxWidth: 28,
        barCategoryGap: '34%',
      },
      {
        name: '输出 Tokens',
        type: 'bar',
        stack: 'tokens',
        data: days.map(d => d.completion),
        itemStyle: { color: accent, borderRadius: [5, 5, 0, 0] },
        barMaxWidth: 28,
        barCategoryGap: '34%',
      },
      {
        name: '请求数',
        type: 'line',
        yAxisIndex: 1,
        data: days.map(d => d.requests),
        smooth: true,
        symbol: 'circle',
        symbolSize: 5,
        lineStyle: { color: requestColor, width: 2 },
        itemStyle: { color: requestColor, borderColor: cssVar('--surface', '#fff'), borderWidth: 2 },
      },
    ],
  };
});

const shareLegend = computed(() => {
  const total = totalTokens.value;
  const colors = ['var(--primary)', 'var(--accent-3)', 'var(--accent-2)', 'var(--ok)', 'var(--warn)', 'var(--muted)'];
  return modelShare.value.slice(0, 6).map((model, index) => ({
    ...model,
    percentage: total > 0 ? model.value / total * 100 : 0,
    color: colors[index % colors.length],
  }));
});

// ----- 模型占比环图 -----
const shareEl = useEChart(() => ({
  animationDuration: 420,
  tooltip: { trigger: 'item', formatter: '{b}<br/>{c} tokens ({d}%)' },
  legend: { show: false },
  series: [{
    type: 'pie',
    radius: ['56%', '78%'],
    center: ['50%', '48%'],
    avoidLabelOverlap: true,
    itemStyle: { borderColor: cssVar('--surface', '#fff'), borderWidth: 3, borderRadius: 5 },
    emphasis: { scale: true, scaleSize: 5 },
    label: {
      show: true,
      position: 'center',
      formatter: () => `{a|${fmtExactNum(totalTokens.value)}}\n{b|总 Tokens}`,
      rich: {
        a: { fontSize: 22, fontWeight: 700, color: cssVar('--text', '#18181b'), lineHeight: 30 },
        b: { fontSize: 11, color: cssVar('--muted', '#a1a1aa'), lineHeight: 18 },
      },
    },
    data: modelShare.value.map((model, index) => ({
      ...model,
      itemStyle: {
        color: [
          cssVar('--primary', '#18181b'),
          cssVar('--accent-3', '#d4d4d8'),
          cssVar('--accent-2', '#a1a1aa'),
          cssVar('--ok', '#16a34a'),
          cssVar('--warn', '#b45309'),
          cssVar('--muted', '#a1a1aa'),
        ][index % 6],
      },
    })),
  }],
}));

interface StatRow {
  model: string;
  requests: number;
  success: number;
  rate_limited: number;
  errors: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  average_tokens: number;
  share: number;
  last_used?: string;
}

const rows = computed<StatRow[]>(() =>
  Object.entries(stats.value)
    .map(([name, s]) => ({
      model: name.replace('models/', ''),
      requests: s.requests || 0,
      success: s.success || 0,
      rate_limited: s.rate_limited || 0,
      errors: s.errors || 0,
      prompt_tokens: s.prompt_tokens || 0,
      completion_tokens: s.completion_tokens || 0,
      total_tokens: s.total_tokens || 0,
      average_tokens: s.requests ? Math.round((s.total_tokens || 0) / s.requests) : 0,
      share: totalTokens.value ? (s.total_tokens || 0) / totalTokens.value * 100 : 0,
      last_used: s.last_used,
    }))
    .sort((a, b) => b.total_tokens - a.total_tokens || b.requests - a.requests),
);

function rowRate(row: StatRow): string {
  return row.requests > 0 ? `${Math.round(row.success / row.requests * 100)}%` : '-';
}

</script>

<template>
  <div class="page dashboard-page">
    <div class="dashboard-heading">
      <div>
        <div class="page-kicker"><span class="kicker-dot"></span> ANALYTICS <span class="kicker-divider">/</span> USAGE</div>
        <div class="page-title">用量统计</div>
        <div class="page-sub">按模型查看请求、Token 消耗与运行质量，数据按 UTC 日期持久化保存。</div>
      </div>
      <button class="dashboard-refresh" :class="{ loading }" :disabled="loading" type="button" @click="loadStats">
        <Icon name="refresh" :size="15" :class="{ spin: loading }" />
        <span>{{ loading ? '更新中' : '刷新数据' }}</span>
      </button>
    </div>

    <div v-if="error" class="dashboard-alert" role="alert">
      <span>{{ error }}</span>
      <button type="button" @click="loadStats">重试</button>
    </div>

    <section class="overview-card" aria-labelledby="overview-title">
      <div class="overview-primary">
        <div id="overview-title" class="metric-label">累计 Token 消耗 <span class="metric-badge">{{ hasStats ? '已记录' : '暂无记录' }}</span></div>
        <div class="overview-value">{{ fmtExactNum(animatedTotalTokens) }}</div>
        <div class="overview-caption">
          <span>今日 {{ fmtExactNum(animatedTodayTokens) }} Tokens</span>
          <span class="caption-separator">·</span>
          <span>{{ fmtNum(todaySummary.requests) }} 次请求</span>
          <span class="caption-separator">·</span>
          <span>{{ modelCount }} 个模型</span>
          <span class="caption-separator">·</span>
          <span>{{ activeDays }} 个活跃日</span>
        </div>
      </div>
      <div class="overview-divider"></div>
      <div class="overview-kpis">
        <div v-for="item in overviewItems" :key="item.label" class="overview-kpi">
          <div class="kpi-label"><span class="kpi-dot" :class="item.tone"></span>{{ item.label }}</div>
          <div class="kpi-value">{{ item.value }}</div>
          <div class="kpi-note">{{ item.note }}</div>
        </div>
      </div>
    </section>

    <div class="dashboard-section-heading">
      <div>
        <h2>使用概览</h2>
        <p>输入与输出 Token 的每日消耗趋势</p>
      </div>
      <div class="range-switch" role="group" aria-label="趋势时间范围">
        <button v-for="option in rangeOptions" :key="option" type="button" :class="{ active: range === option }" :aria-pressed="range === option" @click="chooseRange(option)">
          近 {{ option }} 天
        </button>
      </div>
    </div>

    <section class="dashboard-chart-grid">
      <article class="dashboard-card trend-card">
        <div class="card-head">
          <div>
            <h3>Token 消耗趋势</h3>
            <p>{{ rangeLabel }}的每日汇总</p>
          </div>
          <span class="card-badge">{{ hasTrendData ? '有明细' : '待产生' }}</span>
        </div>
        <div class="chart-summary">
          <div><strong>{{ fmtExactNum(trendSummary.total) }}</strong><span>区间总量</span></div>
          <div><strong>{{ fmtExactNum(trendSummary.average) }}</strong><span>日均 Tokens</span></div>
          <div><strong>{{ fmtNum(trendSummary.requests) }}</strong><span>区间请求</span></div>
          <div><strong>{{ fmtNum(trendSummary.requestAverage) }}</strong><span>日均请求</span></div>
          <div><strong>{{ hasTrendData ? shortDate(trendSummary.peak.date) : '-' }}</strong><span>消耗峰值日</span></div>
        </div>
        <div class="dashboard-chart-wrap trend-chart-wrap">
          <div :ref="(el) => { trendEl = el as HTMLElement | null }" class="dashboard-chart trend-chart"></div>
          <div v-if="loading" class="chart-empty skeleton skel-chart"></div>
          <div v-else-if="!hasTrendData" class="chart-empty"><span class="empty-icon">—</span><strong>还没有每日用量明细</strong><span>完成一次请求后，Token 与请求趋势会显示在这里</span></div>
        </div>
        <div class="chart-legend">
          <span><i class="legend-swatch input"></i>输入 Tokens</span>
          <span><i class="legend-swatch output"></i>输出 Tokens</span>
          <span><i class="legend-swatch requests"></i>请求数</span>
        </div>
      </article>

      <article class="dashboard-card share-card">
        <div class="card-head">
          <div>
            <h3>模型 Token 占比</h3>
            <p>按累计 Token 用量排序</p>
          </div>
          <span class="card-badge">{{ modelCount }} 个模型</span>
        </div>
        <div class="dashboard-chart-wrap share-chart-wrap">
          <div :ref="(el) => { shareEl = el as HTMLElement | null }" class="dashboard-chart share-chart"></div>
          <div v-if="loading" class="chart-empty skeleton skel-chart"></div>
          <div v-else-if="!modelShare.length" class="chart-empty"><span class="empty-icon">○</span><strong>暂未收到 Token 用量</strong><span>上游返回用量后会自动拆分模型占比</span></div>
        </div>
        <div v-if="shareLegend.length" class="model-legend">
          <div v-for="item in shareLegend" :key="item.name" class="model-legend-row">
            <span class="legend-swatch" :style="{ background: item.color }"></span>
            <span class="model-legend-name" :title="item.name">{{ item.name }}</span>
            <span class="model-legend-value">{{ item.percentage.toFixed(1) }}%</span>
          </div>
          <div v-if="modelShare.length > shareLegend.length" class="model-legend-more">+ {{ modelShare.length - shareLegend.length }} 个模型</div>
        </div>
      </article>
    </section>

    <section class="dashboard-card details-card">
      <div class="card-head details-head section-toggle" :class="{ collapsed: collapsedSections.models }" @click="toggleSection('models')">
        <div>
          <h3>模型明细</h3>
          <p>请求状态与 Token 消耗明细</p>
        </div>
        <span class="card-badge">{{ rows.length }} 个模型</span>
        <span class="row-caret section-caret" :class="{ open: !collapsedSections.models }">▾</span>
      </div>

      <div v-if="rows.length" v-show="!collapsedSections.models" class="desktop-table-wrap">
        <table class="usage-table">
          <thead>
            <tr>
              <th>模型</th>
              <th>请求</th>
              <th>成功率</th>
              <th>错误</th>
              <th>限流</th>
              <th>输入 Tokens</th>
              <th>输出 Tokens</th>
              <th>平均 / 请求</th>
              <th>总 Tokens</th>
              <th>占比</th>
              <th>最后使用</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.model">
              <td><span class="table-model" :title="row.model">{{ row.model }}</span></td>
              <td>{{ fmtNum(row.requests) }}</td>
              <td><span class="rate-chip" :class="{ muted: rowRate(row) === '-' }">{{ rowRate(row) }}</span></td>
              <td>{{ fmtNum(row.errors) }}</td>
              <td>{{ fmtNum(row.rate_limited) }}</td>
              <td>{{ fmtExactNum(row.prompt_tokens) }}</td>
              <td>{{ fmtExactNum(row.completion_tokens) }}</td>
              <td>{{ fmtExactNum(row.average_tokens) }}</td>
              <td class="total-cell">{{ fmtExactNum(row.total_tokens) }}</td>
              <td>{{ row.share.toFixed(1) }}%</td>
              <td class="last-used">{{ fmtDate(row.last_used) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="rows.length" v-show="!collapsedSections.models" class="mobile-model-list">
        <article v-for="row in rows" :key="row.model" class="log-row expandable" @click="toggleExpanded(`model:${row.model}`)">
          <div class="log-row-line">
            <span class="log-row-model" :title="row.model">{{ row.model }}</span>
            <span class="log-row-num">{{ fmtNum(row.total_tokens) }} tok</span>
            <span class="log-row-num">{{ fmtNum(row.requests) }} 次</span>
            <span class="log-row-num success-text">{{ rowRate(row) }}</span>
            <span class="row-caret" :class="{ open: isExpanded(`model:${row.model}`) }">▾</span>
          </div>
          <div v-if="isExpanded(`model:${row.model}`)" class="log-row-detail">
            <span>输入 {{ fmtExactNum(row.prompt_tokens) }}</span>
            <span>输出 {{ fmtExactNum(row.completion_tokens) }}</span>
            <span>平均 / 请求 {{ fmtExactNum(row.average_tokens) }}</span>
            <span>占比 {{ row.share.toFixed(1) }}%</span>
            <span>错误 {{ fmtNum(row.errors) }} · 限流 {{ fmtNum(row.rate_limited) }}</span>
            <span>最后使用 {{ fmtDate(row.last_used) }}</span>
          </div>
        </article>
      </div>

      <div v-else-if="!collapsedSections.models" class="details-empty">
        <span class="empty-icon">∅</span>
        <strong>暂无模型明细</strong>
        <span>发起一次 API 请求后，这里会显示各模型的使用情况</span>
      </div>
    </section>

    <section class="dashboard-card daily-details-card">
      <div class="card-head details-head section-toggle" :class="{ collapsed: collapsedSections.daily }" @click="toggleSection('daily')">
        <div>
          <h3>每日明细</h3>
          <p>{{ rangeLabel }}的请求、Token 构成与平均消耗</p>
        </div>
        <span class="card-badge">{{ dailyRows.length }} 个活跃日</span>
        <span class="row-caret section-caret" :class="{ open: !collapsedSections.daily }">▾</span>
      </div>

      <div v-if="dailyRows.length" v-show="!collapsedSections.daily" class="daily-table-wrap">
        <table class="daily-table">
          <thead>
            <tr>
              <th>日期</th>
              <th>请求</th>
              <th>模型</th>
              <th>输入 Tokens</th>
              <th>输出 Tokens</th>
              <th>总 Tokens</th>
              <th>平均 / 请求</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="day in dailyRows" :key="day.date">
              <td class="daily-date">{{ shortDate(day.date) }}</td>
              <td>{{ fmtNum(day.requests) }}</td>
              <td>{{ day.modelCount }}</td>
              <td>{{ fmtExactNum(day.prompt) }}</td>
              <td>{{ fmtExactNum(day.completion) }}</td>
              <td class="total-cell">{{ fmtExactNum(day.total) }}</td>
              <td>{{ fmtExactNum(day.average) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="dailyRows.length" v-show="!collapsedSections.daily" class="mobile-daily-list">
        <article v-for="day in dailyRows" :key="day.date" class="log-row expandable" @click="toggleExpanded(`day:${day.date}`)">
          <div class="log-row-line">
            <strong class="log-row-time">{{ shortDate(day.date) }}</strong>
            <span class="log-row-model">{{ day.modelCount }} 模型</span>
            <span class="log-row-num">{{ fmtNum(day.total) }} tok</span>
            <span class="log-row-num">{{ fmtNum(day.requests) }} 次</span>
            <span class="log-row-num">均 {{ fmtNum(day.average) }}</span>
            <span class="row-caret" :class="{ open: isExpanded(`day:${day.date}`) }">▾</span>
          </div>
          <div v-if="isExpanded(`day:${day.date}`)" class="log-row-detail">
            <span>输入 {{ fmtExactNum(day.prompt) }}</span>
            <span>输出 {{ fmtExactNum(day.completion) }}</span>
            <span>总 Tokens {{ fmtExactNum(day.total) }}</span>
            <span>平均 / 请求 {{ fmtExactNum(day.average) }}</span>
          </div>
        </article>
      </div>

      <div v-else-if="!collapsedSections.daily" class="details-empty">
        <span class="empty-icon">∅</span>
        <strong>暂无每日明细</strong>
        <span>产生请求后，这里会显示每个日期的 Token 构成和平均消耗</span>
      </div>
    </section>

    <section class="dashboard-card logs-card">
      <div class="card-head details-head section-toggle" :class="{ collapsed: collapsedSections.logs }" @click="toggleSection('logs')">
        <div>
          <h3>请求日志</h3>
          <p>每次 API 调用的明细：状态、缓存命中、Token 与耗时</p>
        </div>
        <div class="log-actions">
          <span class="card-badge">最近 {{ requestLogs.length }} 条</span>
          <button class="ghost-btn" type="button" :disabled="logsLoading" @click.stop="loadLogs()">刷新</button>
          <span class="row-caret section-caret" :class="{ open: !collapsedSections.logs }">▾</span>
        </div>
      </div>

      <div v-if="requestLogs.length" v-show="!collapsedSections.logs" class="daily-table-wrap">
        <table class="daily-table log-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>类型</th>
              <th>模型</th>
              <th>状态</th>
              <th>缓存</th>
              <th>Tokens</th>
              <th>耗时</th>
              <th>账号</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="log in visibleLogs" :key="log.id">
              <tr class="log-table-row" @click="toggleExpanded(`log:${log.id}`)">
                <td class="daily-date">{{ logTime(log.created_at) }}</td>
                <td>原生生成</td>
                <td class="log-model" :title="log.model">{{ log.model.replace(/^models\//, '') }}</td>
                <td><span class="rate-chip" :class="logStatusClass(log.status)">{{ logStatusText(log.status) }}</span></td>
                <td>{{ logCacheText(log.cache) }}</td>
                <td class="total-cell">{{ log.total_tokens ? fmtExactNum(log.total_tokens) : '—' }}<span v-if="isCachedLog(log) && log.total_tokens" class="cache-mark" title="来自缓存响应，未计入用量统计">缓存</span></td>
                <td>{{ logLatency(log.latency_ms) }}</td>
                <td class="log-account" :title="log.error || log.account || ''">{{ log.error ? logShortError(log.error) : (log.account ? log.account.slice(0, 8) : '—') }}</td>
              </tr>
              <tr v-if="isExpanded(`log:${log.id}`)" class="log-table-detail-row">
                <td colspan="8">
                  <span>{{ logFullTime(log.created_at) }}</span>
                  <span v-if="log.total_tokens">输入 {{ fmtExactNum(log.prompt_tokens) }} · 输出 {{ fmtExactNum(log.completion_tokens) }}</span>
                  <span v-if="log.attempts > 1">重试 {{ log.attempts }} 次</span>
                  <span v-if="log.account">账号 {{ log.account }}</span>
                  <span v-if="log.error" class="log-row-error-detail">{{ log.error }}</span>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
        <button v-if="hasMoreLogs" class="ghost-btn log-more-btn" type="button" @click="showMoreLogs">显示更多（还有 {{ requestLogs.length - logDisplayCount }} 条）</button>
      </div>

      <div v-if="requestLogs.length" v-show="!collapsedSections.logs" class="mobile-daily-list">
        <article v-for="log in visibleLogs" :key="log.id" class="log-row expandable" :class="{ failed: log.status !== 'success' }" @click="toggleExpanded(`log:${log.id}`)">
          <div class="log-row-line">
            <span class="log-row-time">{{ logTime(log.created_at) }}</span>
            <span class="log-row-model" :title="log.model">{{ log.model.replace(/^models\//, '') }}</span>
            <span class="log-row-num">{{ log.total_tokens ? fmtNum(log.total_tokens) : '—' }} tok<span v-if="isCachedLog(log) && log.total_tokens" class="cache-mark">缓存</span></span>
            <span class="log-row-num">{{ logLatency(log.latency_ms) }}</span>
            <span class="rate-chip" :class="logStatusClass(log.status)">{{ logStatusText(log.status) }}</span>
            <span class="row-caret" :class="{ open: isExpanded(`log:${log.id}`) }">▾</span>
          </div>
          <div v-if="log.error && !isExpanded(`log:${log.id}`)" class="log-row-error" :title="log.error">{{ logShortError(log.error) }}</div>
          <div v-if="isExpanded(`log:${log.id}`)" class="log-row-detail">
            <span>{{ logFullTime(log.created_at) }} · 原生生成</span>
            <span>缓存 {{ logCacheText(log.cache) }}<template v-if="log.attempts > 1"> · 重试 {{ log.attempts }} 次</template></span>
            <span v-if="log.total_tokens">输入 {{ fmtExactNum(log.prompt_tokens) }} · 输出 {{ fmtExactNum(log.completion_tokens) }}</span>
            <span v-if="log.account">账号 {{ log.account }}</span>
            <span v-if="log.error" class="log-row-error-detail">{{ log.error }}</span>
          </div>
        </article>
        <button v-if="hasMoreLogs" class="ghost-btn log-more-btn" type="button" @click="showMoreLogs">显示更多（还有 {{ requestLogs.length - logDisplayCount }} 条）</button>
      </div>

      <div v-else-if="!collapsedSections.logs" class="details-empty">
        <span class="empty-icon">∅</span>
        <strong>{{ logsError || '暂无请求日志' }}</strong>
        <span>发起一次 API 请求后，这里会显示每次调用的明细记录</span>
      </div>
    </section>

    <div v-if="lastLoadedAt" class="dashboard-footnote">最近更新于 {{ lastLoadedAt.toLocaleTimeString() }} · 按 UTC 日期统计，服务端最多保留 90 天明细</div>
  </div>
</template>

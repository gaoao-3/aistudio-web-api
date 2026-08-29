// ---------- 共享数据结构类型 ----------

export type Role = 'user' | 'assistant';

export interface ToolCall {
  id?: string;
  name?: string;
  arguments?: unknown;
  signature?: string;
}

export type AttachmentKind = 'image' | 'audio' | 'video' | 'document';

export interface Attachment {
  name: string;
  mime_type: string;
  data_url: string;
  kind: AttachmentKind;
  size?: number;
}

export interface Message {
  role: Role;
  content: string;
  images?: string[];
  attachments?: Attachment[];
  thinking?: string;
  thinkingSignature?: string;
  showThinking?: boolean;
  toolCalls?: ToolCall[];
  error?: string;
}

export type OnOff = 'on' | 'off';

export type BuiltinToolName = 'google_search' | 'code_execution' | 'google_maps' | 'url_context';

export interface NativePart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  inlineData?: { mimeType: string; data: string };
  fileData?: { fileUri: string; mimeType?: string };
  functionCall?: { name: string; args?: unknown; id?: string };
  functionResponse?: { name: string; response?: unknown; id?: string };
}

export interface NativeContent {
  role: 'user' | 'model';
  parts: NativePart[];
}

export interface NativeGenerateRequest {
  contents: NativeContent[];
  systemInstruction?: NativeContent;
  tools?: Record<string, unknown>[];
  safetySettings?: Record<string, string>[];
  generationConfig?: Record<string, unknown>;
}

export interface RunConfig {
  thinking: string;
  search: OnOff;
  codeExecution: OnOff;
  googleMaps: OnOff;
  urlContext: OnOff;
  stream: OnOff;
  temperature: number;
  topP: number;
  maxTokens: number;
  safety: OnOff;
}

export interface ModelInfo {
  id: string;
}

export interface ModelStat {
  requests?: number;
  success?: number;
  rate_limited?: number;
  errors?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  last_used?: string;
}

export type Stats = Record<string, ModelStat>;

/** 精确响应缓存统计（与后端 ExactResponseCacheStats 对应） */
export interface CacheStats {
  enabled: boolean;
  entries: number;
  totalBytes: number;
  maxBytes: number;
  ttlSeconds: number;
  hits: number;
  misses: number;
  stores: number;
  skippedStores: number;
  expirations: number;
  evictions: number;
  hitRate: number;
  /** 在途去重命中数（相同请求并发时共享上游结果，bridge 级计数） */
  dedupedHits?: number;
}

/** 单次 API 请求明细（与后端 RequestLogRow 对应） */
export interface RequestLog {
  id: number;
  created_at: number;
  kind: 'generate';
  model: string;
  account?: string | null;
  status: 'success' | 'rate_limited' | 'error';
  latency_ms: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache: 'hit' | 'dedup' | 'miss' | 'bypass';
  attempts: number;
  error?: string | null;
}

/** 按天用量（与后端 DailyUsage 对应，date 为 UTC YYYY-MM-DD） */
export interface DailyModelUsage {
  requests?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export type DailyUsage = Record<string, Record<string, DailyModelUsage>>;

export interface Account {
  id: string;
  name?: string | null;
  email?: string | null;
  nickname?: string | null;
  avatar_url?: string | null;
  tier?: 'unknown' | 'free' | 'pro' | 'ultra' | null;
  tier_label?: string | null;
  membership_next_at?: string | null;
  membership_next_at_kind?: 'renewal' | 'expiry' | null;
  profile_updated_at?: string | null;
  profile_error?: string | null;
  auth_state?: 'unknown' | 'healthy' | 'refreshing' | 'refreshed' | 'still_healthy' | 'reauth_required' | 'challenge_required' | 'refresh_failed';
  cookie_checked_at?: string | null;
  cookie_saved_at?: string | null;
  earliest_cookie_expiry?: string | null;
  last_auth_refresh_at?: string | null;
  last_auth_refresh_error?: string | null;
  reauth_url?: string | null;
  created_at?: string;
  success?: number;
  rate_limited?: number;
  error?: number;
  requests?: number;
  errors?: number;
  is_available?: boolean;
  cooldown_remaining?: number;
  last_rate_limited?: string | null;
  auth_expired?: number;
  last_auth_expired?: string | null;
  auth_expired_active?: boolean;
  [key: string]: unknown;
}

export interface RotationConfig {
  mode: string;
  cooldown: number;
}

export interface LocalConversation {
  id: 'current';
  model: string;
  updated_at: string;
  messages: Message[];
}

export type LoginStepKind = 'email' | 'password' | 'otp' | 'selection' | 'manual';

export interface LoginStep {
  kind: LoginStepKind;
  prompt?: string;
  sensitive?: boolean;
  options?: string[];
  phase?: string;
}

export interface RemoteLoginState {
  open: boolean;
  sessionId: string;
  step: LoginStep | null;
  input: string;
  error: string;
  submitting: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

/** 服务设置页单个运行参数（后端 schema + 当前值，数值单位由 type 决定：mib 为 MiB） */
export interface RuntimeSetting {
  key: string;
  env: string;
  label: string;
  description: string;
  type: 'mib' | 'integer' | 'boolean' | 'enum' | 'string';
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: Array<{ value: string | number | boolean; label: string }>;
  default: string | number | boolean;
  effective: string | number | boolean;
  configured: string | number | boolean | null;
  sensitive?: boolean;
  restart_required: boolean;
}

/** 服务设置页配置项输入状态（每卡一个） */
export interface RuntimeSettingInput extends RuntimeSetting {
  input: string | number | boolean | null;
  saving: boolean;
  error: string;
  notice: string;
}

/** 服务设置页状态 */
export interface RuntimeConfigState {
  loading: boolean;
  loaded: boolean;
  globalError: string;
  settings: RuntimeSettingInput[];
}

/** GET/PUT /config/runtime 响应 */
export interface RuntimeConfigResponse {
  settings?: RuntimeSetting[];
  effective_body_limit_bytes?: number;
  configured_body_limit_bytes?: number | null;
  body_limit_max_bytes?: number;
  restart_required?: boolean;
  ok?: boolean;
  detail?: unknown;
}

export interface ToastState {
  show: boolean;
  msg: string;
  t: ReturnType<typeof setTimeout> | null;
}

export interface CookieModalState {
  open: boolean;
  cookies: string;
  name: string;
  email: string;
  importing: boolean;
}

export interface ApiKey {
  id: string;
  name?: string;
  prefix?: string;
  created_at?: string;
  last_used?: string;
}


/** Alpine 魔术属性（x-data 方法内通过 this 访问） */
export interface AlpineMagics {
  $watch(expr: string, cb: () => void, opts?: { deep?: boolean }): void;
  $refs: Record<string, HTMLElement>;
  $nextTick(cb: () => void): void;
}

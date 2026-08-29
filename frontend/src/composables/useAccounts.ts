// ---------- 账号与轮替（从 app.ts 的账号/登录/轮替相关方法移植） ----------
import { computed, ref } from 'vue';
import { apiFetch, toastErr, toastOk } from '../api/client';
import type { Account, CookieModalState, LoginStep, RemoteLoginState, RotationConfig } from '../types';

interface RotationResponse {
  mode?: string;
  cooldown_seconds?: number;
  profile_refresh_ms?: number;
  accounts?: Record<string, Partial<Account>>;
}

interface LoginStartResponse {
  session_id?: string;
  detail?: unknown;
}

interface LoginStatusResponse {
  status?: string;
  email?: string;
  account_id?: string;
  error?: string;
  step?: LoginStep | null;
  detail?: unknown;
}

interface ImportCookiesResponse {
  account_id?: string;
  cookie_count?: number;
  detail?: unknown;
}
interface AuthRefreshResponse {
  status?: Account['auth_state'];
  pageUrl?: string;
  message?: string;
  cookie?: { checkedAt?: string; earliestExpiry?: string; expiringWithinDays?: number; criticalMissing?: string[] };
  detail?: unknown;
}

const accounts = ref<Account[]>([]);
const activeId = ref('');
const activeAccount = ref<Account>({ id: '' });
const accountsLoading = ref(false);
const rotationMode = ref('round_robin');
const rotCfg = ref<RotationConfig>({ mode: 'round_robin', cooldown: 60 });
const profileRefreshMs = ref(6 * 60 * 60 * 1000);
const rotationAccounts = ref<Record<string, Partial<Account>>>({});
const loginInProgress = ref(false);
const localLoginSessionId = ref('');
const remoteLogin = ref<RemoteLoginState>({ open: false, sessionId: '', step: null, input: '', error: '', submitting: false, timer: null });
const cookieModal = ref<CookieModalState>({ open: false, cookies: '', name: '', email: '', importing: false });
const refreshingAccountId = ref('');
const refreshingAuthAccountId = ref('');
const profileRefreshInFlight = new Set<string>();
let remotePollInFlight = false;
let remotePollQueued = false;
let remoteRequestSerial = 0;

export function useAccounts() {
  const accountRows = computed<Account[]>(() =>
    accounts.value.map(a => ({ ...a, ...(rotationAccounts.value[a.id] || {}) })),
  );

  async function loadAccounts(): Promise<void> {
    accountsLoading.value = true;
    try {
      const [a, b] = await Promise.all([
        apiFetch('/accounts').then(r => r.json() as Promise<Account[]>),
        apiFetch('/accounts/active').then(r => r.json() as Promise<Account>),
      ]);
      accounts.value = a || [];
      activeId.value = b?.id || '';
      activeAccount.value = b || { id: '' };
    } catch (e) { /* 保持现有数据 */ }
    finally { accountsLoading.value = false; }
  }

  async function loadRotation(): Promise<void> {
    try {
      const r = await apiFetch('/rotation');
      const d = await r.json() as RotationResponse;
      rotationMode.value = d.mode || 'round_robin';
      rotCfg.value.mode = d.mode || 'round_robin';
      rotCfg.value.cooldown = d.cooldown_seconds || 60;
      profileRefreshMs.value = d.profile_refresh_ms || profileRefreshMs.value;
      rotationAccounts.value = d.accounts || {};
    } catch (e) { /* 保持现有数据 */ }
  }

  function detailMessage(payload: unknown, fallback: string): string {
    if (typeof payload === 'string' && payload.trim()) return payload;
    if (typeof payload === 'object' && payload !== null && 'message' in payload && typeof payload.message === 'string') return payload.message;
    return fallback;
  }

  async function refreshAccountProfile(id: string, silent = false): Promise<void> {
    if (!id || profileRefreshInFlight.has(id)) return;
    profileRefreshInFlight.add(id);
    refreshingAccountId.value = id;
    try {
      const r = await apiFetch(`/accounts/${id}/refresh`, { method: 'POST' });
      const d = await r.json().catch(() => ({})) as Account & { detail?: unknown };
      if (!r.ok) {
        if (!silent) toastErr(detailMessage(d.detail, '读取账号资料失败'));
        return;
      }
      accounts.value = accounts.value.map(account => account.id === id ? { ...account, ...d } : account);
      if (activeId.value === id) activeAccount.value = { ...activeAccount.value, ...d };
      await loadRotation();
      if (!silent) toastOk('账号资料已更新');
    } catch (e) {
      if (!silent) toastErr('读取账号资料失败');
    } finally {
      profileRefreshInFlight.delete(id);
      if (refreshingAccountId.value === id) refreshingAccountId.value = '';
    }
  }

  async function refreshAccountAuth(id: string): Promise<void> {
    if (!id || refreshingAuthAccountId.value) return;
    refreshingAuthAccountId.value = id;
    try {
      const r = await apiFetch(`/accounts/${id}/refresh-auth`, { method: 'POST' });
      const d = await r.json().catch(() => ({})) as AuthRefreshResponse;
      if (!r.ok) {
        toastErr(detailMessage(d.detail, '登录续活失败'));
        return;
      }
      await Promise.all([loadAccounts(), loadRotation()]);
      if (d.status === 'refreshed' || d.status === 'still_healthy') toastOk('Google 登录状态已续活');
      else if (d.status === 'reauth_required') toastErr('Google 要求重新登录，请使用浏览器登录恢复账号');
      else if (d.status === 'challenge_required') toastErr('Google 要求二次验证，请使用浏览器登录完成验证');
      else toastErr(d.message || '登录续活失败');
    } catch {
      toastErr('登录续活请求失败');
    } finally {
      refreshingAuthAccountId.value = '';
    }
  }

  async function refreshStaleProfiles(): Promise<void> {
    const now = Date.now();
    for (const account of accountRows.value) {
      const updated = account.profile_updated_at ? Date.parse(account.profile_updated_at) : 0;
      const retryAfter = account.profile_error ? 30 * 60 * 1000 : 0;
      if (!updated || now - updated > (retryAfter || profileRefreshMs.value)) {
        await refreshAccountProfile(account.id, true);
      }
    }
  }

  async function saveRotation(): Promise<void> {
    try {
      await apiFetch('/rotation/mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: rotCfg.value.mode, cooldown_seconds: rotCfg.value.cooldown }),
      });
      toastOk('已保存');
      loadRotation();
    } catch (e) { toastErr('保存失败'); }
  }

  async function forceNext(): Promise<void> {
    try {
      await apiFetch('/rotation/next', { method: 'POST' });
      toastOk('已切换账号');
      loadAccounts();
    } catch (e) { toastErr('切换失败'); }
  }

  async function activateAccount(id: string): Promise<void> {
    try {
      await apiFetch(`/accounts/${id}/activate`, { method: 'POST' });
      toastOk('已激活');
      loadAccounts();
      loadRotation();
    } catch (e) { toastErr('激活失败'); }
  }

  async function deleteAccount(id: string): Promise<void> {
    try {
      const r = await apiFetch(`/accounts/${id}`, { method: 'DELETE' });
      if (r.ok) { toastOk('已删除'); loadAccounts(); loadRotation(); }
      else toastErr('删除失败');
    } catch (e) { toastErr('网络错误'); }
  }

  function loginErrorMessage(error?: string): string {
    if (!error) return '登录失败';
    if (/execution context was destroyed|cannot find context with specified id|frame was detached/iu.test(error)) {
      return '登录页面正在跳转，请重新打开远程登录后再试。';
    }
    if (error.includes('XServer') || error.includes('Missing X server') || error.includes('$DISPLAY')) {
      return '登录浏览器启动失败：当前服务器没有可用显示服务。请改用远程登录或导入 Cookies。';
    }
    const msg = `登录失败：${error}`;
    return msg.length > 180 ? `${msg.slice(0, 177)}...` : msg;
  }

  // ----- 本地浏览器登录 -----

  async function addAccount(): Promise<void> {
    if (loginInProgress.value) return;
    loginInProgress.value = true;
    try {
      const r = await apiFetch('/accounts/login/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const d = await r.json().catch(() => ({})) as LoginStartResponse;
      if (!r.ok || !d.session_id) {
        toastErr((d.detail as string) || '启动登录失败');
        return;
      }
      localLoginSessionId.value = d.session_id;
      toastOk('登录已开始，请在弹出的浏览器完成登录');
      await pollLoginStatus(d.session_id);
    } catch (e) {
      toastErr('网络错误');
    } finally {
      localLoginSessionId.value = '';
      loginInProgress.value = false;
    }
  }

  async function cancelLocalLogin(): Promise<void> {
    const sessionId = localLoginSessionId.value;
    if (!sessionId) return;
    localLoginSessionId.value = '';
    try {
      const r = await apiFetch(`/accounts/login/${sessionId}`, { method: 'DELETE' });
      if (r.ok) toastOk('已取消登录'); else toastErr('取消登录失败');
    } catch (e) {
      toastErr('取消登录失败');
    }
  }

  async function pollLoginStatus(sessionId: string): Promise<void> {
    const deadline = Date.now() + 605000;
    while (Date.now() < deadline && localLoginSessionId.value === sessionId) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      try {
        const r = await apiFetch(`/accounts/login/status/${sessionId}`);
        const d = await r.json().catch(() => ({})) as LoginStatusResponse;
        if (!r.ok) {
          toastErr((d.detail as string) || '查询登录状态失败');
          return;
        }
        if (d.status === 'completed') {
          if (d.account_id) {
            await apiFetch(`/accounts/${d.account_id}/activate`, { method: 'POST' });
            void refreshAccountProfile(d.account_id, true);
          }
          toastOk(`登录成功${d.email ? ': ' + d.email : ''}`);
          loadAccounts();
          loadRotation();
          return;
        }
        if (d.status === 'failed') {
          toastErr(loginErrorMessage(d.error));
          return;
        }
        if (d.status === 'cancelled') return;
      } catch (e) {
        toastErr('查询登录状态失败');
        return;
      }
    }
    toastErr('登录仍未完成，请稍后刷新账号列表');
  }

  // ----- 远程登录 -----

  async function startRemoteLogin(): Promise<void> {
    if (remoteLogin.value.open) return;
    try {
      const r = await apiFetch('/accounts/login/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remote: true }),
      });
      const d = await r.json().catch(() => ({})) as LoginStartResponse;
      if (!r.ok || !d.session_id) { toastErr((d.detail as string) || '启动登录失败'); return; }
      remoteRequestSerial += 1;
      remotePollQueued = false;
      Object.assign(remoteLogin.value, { open: true, sessionId: d.session_id, step: null, input: '', error: '', submitting: false });
      void pollRemoteLogin();
    } catch (e) { toastErr('网络错误'); }
  }

  async function pollRemoteLogin(): Promise<void> {
    const rl = remoteLogin.value;
    if (rl.timer) { clearTimeout(rl.timer); rl.timer = null; }
    if (!rl.open || !rl.sessionId) return;
    if (remotePollInFlight) {
      remotePollQueued = true;
      return;
    }
    const serial = remoteRequestSerial;
    remotePollInFlight = true;
    let terminal = false;
    try {
      const r = await apiFetch(`/accounts/login/status/${rl.sessionId}`);
      const d = await r.json().catch(() => ({})) as LoginStatusResponse;
      if (!rl.open || remoteRequestSerial !== serial) return;
      if (!r.ok) rl.error = typeof d.detail === 'string' ? d.detail : '查询登录状态失败';
      else if (d.status === 'completed') {
        terminal = true;
        await closeRemoteLogin(false);
        toastOk(`登录成功${d.email ? ': ' + d.email : ''}`);
        loadAccounts();
        loadRotation();
        if (d.account_id) void refreshAccountProfile(d.account_id, true);
        return;
      }
      else if (d.status === 'failed') {
        terminal = true;
        rl.error = loginErrorMessage(d.error);
      }
      else rl.step = d.step || null;
    } catch (e) {
      if (rl.open && remoteRequestSerial === serial) rl.error = '网络错误';
    } finally {
      remotePollInFlight = false;
      if (remotePollQueued) {
        remotePollQueued = false;
        if (rl.open) void pollRemoteLogin();
      } else if (rl.open && !terminal && remoteRequestSerial === serial) {
        rl.timer = setTimeout(() => { void pollRemoteLogin(); }, 2000);
      }
    }
  }

  async function submitRemoteInput(value: string): Promise<void> {
    const rl = remoteLogin.value;
    if (!rl.open || !rl.sessionId || rl.submitting) return;
    const sessionId = rl.sessionId;
    remoteRequestSerial += 1;
    rl.submitting = true;
    if (rl.timer) { clearTimeout(rl.timer); rl.timer = null; }
    try {
      const r = await apiFetch('/accounts/login/input', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, value }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({})) as { detail?: unknown };
        const detail = typeof d.detail === 'string'
          ? d.detail
          : (typeof d.detail === 'object' && d.detail !== null && 'message' in d.detail && typeof d.detail.message === 'string' ? d.detail.message : undefined);
        toastErr(detail || '提交失败');
        return;
      }
      if (!rl.open || rl.sessionId !== sessionId) return;
      rl.input = '';
      rl.step = null;
      rl.error = '';
      void pollRemoteLogin();
    } catch (e) { toastErr('网络错误'); }
    finally {
      if (rl.sessionId === sessionId) rl.submitting = false;
    }
  }

  async function closeRemoteLogin(cancelSession = true): Promise<void> {
    const rl = remoteLogin.value;
    if (rl.timer) clearTimeout(rl.timer);
    const sessionId = rl.sessionId;
    remoteRequestSerial += 1;
    remotePollQueued = false;
    Object.assign(rl, { open: false, sessionId: '', step: null, input: '', error: '', submitting: false });
    if (cancelSession && sessionId) {
      try { await apiFetch(`/accounts/login/${sessionId}`, { method: 'DELETE' }); } catch (e) { /* 会话会在服务端超时清理 */ }
    }
  }

  function remoteStepIcon(kind: string): string {
    const map: Record<string, string> = { email: 'mail', password: 'lock', otp: 'shield', selection: 'list', manual: 'phone' };
    return map[kind] || 'devices';
  }

  // ----- Cookie 导入 -----

  async function importCookies(): Promise<void> {
    const cm = cookieModal.value;
    const raw = cm.cookies.trim();
    if (!raw) { toastErr('请输入 Cookie'); return; }
    // 支持多行：每行一个 cookie 或用分号分隔
    const cookies = raw.split(/[\r\n]+/).map(l => l.trim()).filter(Boolean).join('; ');
    cm.importing = true;
    try {
      const body: { cookies: string; name?: string; email?: string } = { cookies };
      if (cm.name.trim()) body.name = cm.name.trim();
      if (cm.email.trim()) body.email = cm.email.trim();
      const r = await apiFetch('/accounts/import-cookies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json() as ImportCookiesResponse;
      if (r.ok) {
        toastOk(`导入成功: ${d.cookie_count} 个 cookie`);
        Object.assign(cm, { open: false, cookies: '', name: '', email: '' });
        loadAccounts();
        loadRotation();
        if (d.account_id) void refreshAccountProfile(d.account_id, true);
      } else {
        toastErr((d.detail as string) || '导入失败');
      }
    } catch (e) { toastErr('网络错误'); }
    finally { cm.importing = false; }
  }

  return {
    accounts, activeId, activeAccount, accountsLoading,
    rotationMode, rotCfg, rotationAccounts, accountRows,
    loginInProgress, localLoginSessionId, remoteLogin, cookieModal, refreshingAccountId, refreshingAuthAccountId,
    loadAccounts, loadRotation, saveRotation, forceNext, activateAccount, deleteAccount,
    refreshAccountProfile, refreshAccountAuth, refreshStaleProfiles,
    addAccount, cancelLocalLogin,
    startRemoteLogin, pollRemoteLogin, submitRemoteInput, closeRemoteLogin, remoteStepIcon,
    importCookies,
  };
}

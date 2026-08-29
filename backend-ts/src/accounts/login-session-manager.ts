import { createHash, randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { launchPersistentContext } from "cloakbrowser";
import type { BrowserContext, Page } from "playwright-core";
import { settings } from "../config.js";
import type { AccountMeta, AccountStore, BrowserStorageState } from "./account-store.js";

export type LoginStatus = "pending" | "completed" | "failed" | "cancelled";
export type LoginStepKind = "email" | "password" | "otp" | "selection" | "manual";

export interface LoginStep {
  readonly kind: LoginStepKind;
  readonly prompt: string;
  readonly sensitive?: boolean;
  readonly options?: readonly string[];
  readonly phase?: string;
}

export interface LoginSessionView {
  readonly session_id: string;
  readonly status: LoginStatus;
  readonly account_id?: string;
  readonly email?: string;
  readonly error?: string;
  readonly step?: LoginStep;
  readonly remote: boolean;
  readonly created_at: string;
}

interface LoginSessionRecord {
  readonly id: string;
  readonly name: string | undefined;
  readonly remote: boolean;
  readonly createdAt: string;
  readonly controller: AbortController;
  status: LoginStatus;
  accountId: string | undefined;
  email: string | undefined;
  error: string | undefined;
  step: LoginStep | undefined;
  input: string | undefined;
  context: BrowserContext | undefined;
}

export interface LoginSessionBackend {
  start(input: { readonly name?: string; readonly remote: boolean }): Promise<{ session_id: string }>;
  status(sessionId: string): LoginSessionView | undefined;
  screenshot(sessionId: string): Promise<{ readonly image: string; readonly width: number; readonly height: number } | "missing" | "not_ready">;
  click(sessionId: string, xRatio: number, yRatio: number): Promise<"ok" | "missing" | "not_ready">;
  submit(sessionId: string, value: string): "ok" | "missing" | "not_waiting";
  cancel(sessionId: string): Promise<"ok" | "missing">;
  stop(): Promise<void>;
}

const LOGIN_URL = "https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Faistudio.google.com&hl=zh-CN";
const AI_STUDIO_URL = "https://aistudio.google.com/";
const AUTH_COOKIE_NAMES = new Set(["SID", "APISID", "SAPISID", "__Secure-1PSID", "__Secure-3PSID"]);

function loginFingerprint(sessionId: string): number {
  const prefix = createHash("sha256").update(sessionId).digest("hex").slice(0, 8);
  return 10_000 + (Number.parseInt(prefix, 16) % 90_000);
}

/** Google 登录页切换步骤时会短暂销毁当前 execution context。 */
function isNavigationContextError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /execution context was destroyed|cannot find context with specified id|frame was detached/iu.test(message);
}

export function loginPhaseFromUrl(url: string): string | undefined {
  if (/^https:\/\/gds\.google\.com\/web\/(?:landing|recoveryoptions)(?:[/?#]|$)/iu.test(url)) return "selection";
  if (!url.includes("accounts.google.com")) return undefined;
  const known: readonly [string, string][] = [
    ["/v3/signin/identifier", "identifier"],
    ["/v3/signin/challenge/pwd", "pwd"],
    ["/v3/signin/challenge/dp", "dp"],
    ["/v3/signin/challenge/recaptcha", "recaptcha"],
    ["/v3/signin/challenge/selection", "selection"],
    ["/v3/signin/challenge/totp", "totp"],
    ["/v3/signin/challenge/ootp", "ootp"],
    ["/v3/signin/challenge/idv", "idv"],
    ["/v3/signin/challenge/ipp", "ipp"],
    ["/v3/signin/challenge/backupcode", "backupcode"],
    ["/v3/signin/challenge/authzen", "authzen"],
    ["/v3/signin/challenge/pk", "passkey"],
    ["/v3/signin/challenge/webauthn", "webauthn"],
    ["/v3/signin/speedbump/passkeyenrollment", "selection"],
  ];
  return known.find(([marker]) => url.includes(marker))?.[1];
}

function publicSession(session: LoginSessionRecord): LoginSessionView {
  return {
    session_id: session.id,
    status: session.status,
    ...(session.accountId ? { account_id: session.accountId } : {}),
    ...(session.email ? { email: session.email } : {}),
    ...(session.error ? { error: session.error } : {}),
    ...(session.step ? { step: structuredClone(session.step) } : {}),
    remote: session.remote,
    created_at: session.createdAt,
  };
}

async function removeLoginDirectory(path: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch {
      if (attempt < 7) await delay(150 * (attempt + 1));
    }
  }
}

export class LoginSessionManager implements LoginSessionBackend {
  private readonly sessions = new Map<string, LoginSessionRecord>();
  private readonly tasks = new Map<string, Promise<void>>();

  constructor(private readonly accounts: AccountStore) {}

  async start(input: { readonly name?: string; readonly remote: boolean }): Promise<{ session_id: string }> {
    if ([...this.sessions.values()].some(session => session.status === "pending")) {
      throw new Error("已有登录流程正在进行，请先完成或取消");
    }
    const id = `login_${randomBytes(8).toString("hex")}`;
    const session: LoginSessionRecord = {
      id,
      name: input.name?.trim() || undefined,
      remote: input.remote,
      createdAt: new Date().toISOString(),
      controller: new AbortController(),
      status: "pending",
      accountId: undefined,
      email: undefined,
      error: undefined,
      input: undefined,
      context: undefined,
      step: {
        kind: "manual",
        prompt: input.remote ? "正在启动远程登录浏览器…" : "请在弹出的浏览器中完成 Google 登录",
      },
    };
    this.sessions.set(id, session);
    const task = this.run(session).finally(() => {
      this.tasks.delete(id);
      const timer = setTimeout(() => this.sessions.delete(id), settings.loginSessionRetentionMs);
      timer.unref();
    });
    this.tasks.set(id, task);
    return { session_id: id };
  }

  status(sessionId: string): LoginSessionView | undefined {
    const session = this.sessions.get(sessionId);
    return session ? publicSession(session) : undefined;
  }

  async screenshot(sessionId: string): Promise<{ readonly image: string; readonly width: number; readonly height: number } | "missing" | "not_ready"> {
    const session = this.sessions.get(sessionId);
    if (!session) return "missing";
    const page = session.context?.pages()[0];
    if (!page || page.isClosed() || session.status !== "pending") return "not_ready";
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const image = await page.screenshot({ type: "jpeg", quality: 65 });
    return { image: `data:image/jpeg;base64,${image.toString("base64")}`, ...viewport };
  }

  async click(sessionId: string, xRatio: number, yRatio: number): Promise<"ok" | "missing" | "not_ready"> {
    const session = this.sessions.get(sessionId);
    if (!session) return "missing";
    const page = session.context?.pages()[0];
    if (!page || page.isClosed() || session.status !== "pending") return "not_ready";
    if (!Number.isFinite(xRatio) || !Number.isFinite(yRatio) || xRatio < 0 || xRatio > 1 || yRatio < 0 || yRatio > 1) return "not_ready";
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    await page.mouse.click(viewport.width * xRatio, viewport.height * yRatio);
    return "ok";
  }

  submit(sessionId: string, value: string): "ok" | "missing" | "not_waiting" {
    const session = this.sessions.get(sessionId);
    if (!session) return "missing";
    if (!session.remote || session.status !== "pending" || !session.step || session.input !== undefined) {
      return "not_waiting";
    }
    session.input = value;
    return "ok";
  }

  async cancel(sessionId: string): Promise<"ok" | "missing"> {
    const session = this.sessions.get(sessionId);
    if (!session) return "missing";
    if (session.status === "pending") {
      session.status = "cancelled";
      session.step = undefined;
      session.controller.abort();
      await session.context?.close().catch(() => undefined);
    }
    return "ok";
  }

  async stop(): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.status === "pending") {
        session.status = "cancelled";
        session.controller.abort();
        void session.context?.close().catch(() => undefined);
      }
    }
    await Promise.allSettled(this.tasks.values());
  }

  private async run(session: LoginSessionRecord): Promise<void> {
    const loginRoot = join(settings.accountsDir, ".login", session.id);
    const profileDir = join(loginRoot, "profile");
    let context: BrowserContext | undefined;
    try {
      await mkdir(profileDir, { recursive: true });
      context = await launchPersistentContext({
        userDataDir: profileDir,
        headless: session.remote ? true : false,
        stealthArgs: false,
        args: [
          `--fingerprint=${loginFingerprint(session.id)}`,
          "--fingerprint-platform=windows",
          ...(!session.remote ? ["--start-maximized", "--ignore-gpu-blocklist"] : []),
        ],
        ...(settings.proxyUrl ? { proxy: settings.proxyUrl } : {}),
        ...(!session.remote ? { viewport: null } : {}),
      });
      session.context = context;
      const page = context.pages()[0] ?? await context.newPage();
      await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
      const deadline = Date.now() + settings.loginTimeoutMs;

      while (Date.now() < deadline && session.status === "pending") {
        if (session.controller.signal.aborted) throw Object.assign(new Error("登录已取消"), { name: "AbortError" });
        if (page.isClosed()) throw new Error("登录窗口已关闭");
        if (await this.isAuthenticated(context, page)) {
          const { state, email } = await this.finishAuthentication(context, page);
          const saved = await this.accounts.saveStorageState({
            ...(session.name ? { name: session.name } : {}),
            ...(email ? { email } : {}),
            storageState: state,
          });
          session.accountId = saved.account.id;
          session.email = saved.account.email ?? undefined;
          session.status = "completed";
          session.step = undefined;
          return;
        }

        if (session.remote) {
          const step = await this.detectStep(page);
          if (step) session.step = step;
          const input = session.input;
          if (input !== undefined && session.step) {
            session.input = undefined;
            const current = session.step;
            session.step = undefined;
            await this.submitStep(page, current, input);
          }
        }
        await page.waitForTimeout(500);
      }
      if (session.status === "pending") throw new Error("登录超时，请重新尝试");
    } catch (error) {
      if (session.status === "cancelled" || (error as Error).name === "AbortError") {
        session.status = "cancelled";
        session.error = undefined;
      } else {
        session.status = "failed";
        session.error = error instanceof Error ? error.message : String(error);
      }
      session.step = undefined;
    } finally {
      session.input = undefined;
      session.context = undefined;
      await context?.close().catch(() => undefined);
      await removeLoginDirectory(loginRoot);
    }
  }

  private async isAuthenticated(context: BrowserContext, page: Page): Promise<boolean> {
    try {
      if (page.url().includes("accounts.google.com")) return false;
      const cookies = await context.cookies(["https://myaccount.google.com", AI_STUDIO_URL]);
      return cookies.some(cookie => AUTH_COOKIE_NAMES.has(cookie.name));
    } catch (error) {
      if (isNavigationContextError(error)) return false;
      throw error;
    }
  }

  private async finishAuthentication(context: BrowserContext, page: Page): Promise<{ state: BrowserStorageState; email?: string }> {
    await page.goto(AI_STUDIO_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });
    if (page.url().includes("accounts.google.com")) throw new Error("Google 登录未完成或账号无权访问 AI Studio");
    let email: string | undefined;
    try {
      await page.goto("https://myaccount.google.com/", { waitUntil: "domcontentloaded", timeout: 30_000 });
      email = await page.evaluate(() => {
        const text = document.body?.innerText ?? "";
        return text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu)?.[0];
      }) ?? undefined;
    } catch {
      // Email is metadata only; valid cookies are enough to save the account.
    }
    return { state: await context.storageState() as BrowserStorageState, ...(email ? { email } : {}) };
  }

  private async detectStep(page: Page): Promise<LoginStep | undefined> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const phase = loginPhaseFromUrl(page.url());
        const payload = await page.evaluate((currentPhase) => {
          const visible = (element: Element | null): element is HTMLElement => {
            if (!(element instanceof HTMLElement)) return false;
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
          };
          const text = (element: Element | null): string => element?.textContent?.replace(/\s+/gu, " ").trim() ?? "";
          const title = text(document.querySelector("h1, [role='heading']"));
          const password = document.querySelector("input[type='password'], input[name='Passwd']");
          if (visible(password)) return { kind: "password", prompt: title || "请输入密码", sensitive: true };
          const otp = document.querySelector("input[autocomplete='one-time-code'], input[name='totpPin'], input[name='idvPin'], input[name='Pin'], input[name='code'], input[inputmode='numeric'], input[type='tel']");
          if (visible(otp)) return { kind: "otp", prompt: title || "请输入验证码" };
          const email = document.querySelector("input[type='email'], input[name='identifier']");
          if (visible(email)) return { kind: "email", prompt: title || "请输入邮箱" };
          const chooser = [...document.querySelectorAll("[data-identifier]")].filter(visible).map(element => text(element)).filter(Boolean);
          if (chooser.length > 0) return { kind: "selection", prompt: title || "请选择账号", options: [...new Set(chooser)].slice(0, 8) };
          const alternateActions = [...document.querySelectorAll("button, [role='button']")]
            .filter(visible)
            .map(element => text(element))
            .filter(value => /try another way|use another|choose another|尝试其他方式|换一种方式|选择其他|改用其他/iu.test(value));
          if (alternateActions.length > 0) {
            return { kind: "selection", prompt: title || "请选择其他登录方式", options: [...new Set(alternateActions)].slice(0, 8) };
          }
          if (currentPhase === "selection") {
            const ignored = /^(back|next|continue|verify|try another way|use another|choose another|两步验证|2-step verification|two-step verification|帮助|隐私权|条款)$/iu;
            const selectors = "[data-challengetype], [data-challengeid], [role='link'], [role='option'], button, [role='button']";
            const options = [...document.querySelectorAll(selectors)]
              .filter(visible)
              .map(element => text(element))
              .filter(value => value && value !== title && value.length <= 160 && !ignored.test(value));
            const unique = [...new Set(options)].slice(0, 8);
            if (unique.length > 0) return { kind: "selection", prompt: title || "请选择登录方式", options: unique };
          }
          const body = text(document.body).toLowerCase();
          if (/tap yes|check your phone|security key|passkey|qr code|2-step verification|two-step verification|verify it(?:'|’)s you|在手机上|安全密钥|通行密钥|两步验证|验证身份/u.test(body)) {
            return { kind: "manual", prompt: title || "请完成 Google 两步验证" };
          }
          return currentPhase ? { kind: "manual", prompt: title || "请按 Google 页面提示完成验证" } : undefined;
        }, phase);
        if (!payload) return undefined;
        return {
          kind: payload.kind as LoginStepKind,
          prompt: payload.prompt,
          ...(payload.sensitive ? { sensitive: true } : {}),
          ...(payload.options ? { options: payload.options } : {}),
          ...(phase ? { phase } : {}),
        };
      } catch (error) {
        if (!isNavigationContextError(error) || attempt === 2) throw error;
        await page.waitForLoadState("domcontentloaded").catch(() => undefined);
        await page.waitForTimeout(150 * (attempt + 1)).catch(() => undefined);
      }
    }
    return undefined;
  }

  private async submitStep(page: Page, step: LoginStep, rawValue: string): Promise<void> {
    if (step.kind === "selection") {
      const options = step.options ?? [];
      const numeric = /^\d+$/u.test(rawValue.trim()) ? Number.parseInt(rawValue.trim(), 10) - 1 : -1;
      const selected = numeric >= 0 ? options[numeric] : rawValue.trim();
      if (!selected) throw new Error("请选择有效的登录选项");
      try {
        const clicked = await page.evaluate((label) => {
          const visible = (element: Element): element is HTMLElement => {
            if (!(element instanceof HTMLElement)) return false;
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
          };
          const selectors = "[data-identifier], [data-challengetype], [data-challengeid], [role='link'], [role='option'], button, [role='button']";
          const candidates = [...document.querySelectorAll(selectors)].filter(visible);
          const target = candidates.find(element => element.textContent?.replace(/\s+/gu, " ").trim() === label)
            ?? candidates.find(element => element.textContent?.includes(label));
          const clickable = target?.closest("[data-challengetype], [data-challengeid], [data-identifier], [role='link'], [role='option'], button, [role='button']") as HTMLElement | null;
          (clickable ?? target)?.click();
          return Boolean(clickable ?? target);
        }, selected);
        if (!clicked) throw new Error("Google 登录选项已变化，请重试");
      } catch (error) {
        // click 已经触发导航时，旧 execution context 被销毁等价于点击成功。
        if (!isNavigationContextError(error)) throw error;
      }
      return;
    }
    if (step.kind === "manual" || (step.kind === "otp" && rawValue.trim() === "")) {
      let switched = false;
      try {
        switched = await page.evaluate(() => {
          const visible = (element: Element): element is HTMLElement => {
            if (!(element instanceof HTMLElement)) return false;
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
          };
          const target = [...document.querySelectorAll("a, button, [role='link'], [role='button']")]
            .filter(visible)
            .find(element => /try another way|use another|choose another|other sign-in|尝试其他方式|换一种方式|换个方式|选择其他|改用其他|其他登录方式|其他验证方式/iu.test(element.textContent ?? ""));
          target?.click();
          return Boolean(target);
        });
      } catch (error) {
        if (isNavigationContextError(error)) return;
        throw error;
      }
      if (!switched && step.kind === "otp") throw new Error("当前 Google 页面没有可切换的登录方式");
      return;
    }

    const selectors: Record<Exclude<LoginStepKind, "selection" | "manual">, string> = {
      email: "input[type='email'], input[name='identifier']",
      password: "input[type='password'], input[name='Passwd']",
      otp: "input[autocomplete='one-time-code'], input[name='totpPin'], input[name='idvPin'], input[name='Pin'], input[name='code'], input[inputmode='numeric'], input[type='tel']",
    };
    const selector = selectors[step.kind];
    const input = page.locator(selector).first();
    await input.waitFor({ state: "visible", timeout: 10_000 });
    await input.fill(rawValue);
    const next = page.getByRole("button", { name: /^(next|下一步|继续|确认|verify)$/iu }).first();
    try {
      if (await next.isVisible().catch(() => false)) await next.click();
      else await input.press("Enter");
    } catch (error) {
      if (!isNavigationContextError(error)) throw error;
    }
  }
}

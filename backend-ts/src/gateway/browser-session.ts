import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { launchPersistentContext } from "cloakbrowser";
import type { BrowserContext, Cookie, Page, Request } from "playwright-core";
import { settings } from "../config.js";
import { parseAccountProfileSnapshot, type AccountProfile } from "../accounts/account-profile.js";
import { AI_STUDIO_URLS, DIALOG_CLEANUP_JS, GOOGLE_LOGIN_BOOTSTRAP_URL, INSTALL_HOOKS_JS } from "./hooks.js";
import { cleanBrowserCaches } from "./browser-cache.js";
import { AccountRuntimeLease } from "./account-runtime-lease.js";

export interface CapturedTemplate {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /** Account runtime timezone read from the capturing page. */
  readonly timezone?: string;
}

export interface SnapshotContent {
  readonly parts?: readonly {
    readonly text?: unknown;
    readonly inlineData?: { readonly data?: unknown } | readonly [unknown, unknown];
    readonly inline_data?: readonly unknown[];
    readonly fileData?: { readonly fileUri?: unknown } | readonly unknown[];
    readonly file_data?: { readonly file_uri?: unknown } | readonly unknown[];
  }[];
}
export type BrowserStartupStage =
  | "idle"
  | "launching"
  | "navigating"
  | "authenticated"
  | "makersuite_ready"
  | "hooks_installed"
  | "botguard_ready"
  | "healthy"
  | "failed";

export interface CookieHealth {
  readonly criticalPresent: number;
  readonly criticalMissing: readonly string[];
  readonly persistentCookies: number;
  readonly earliestExpiry?: string;
  readonly expiringWithinDays?: number;
  readonly checkedAt: string;
}
export type AuthRefreshStatus = "refreshed" | "still_healthy" | "reauth_required" | "challenge_required" | "refresh_failed";

export interface AuthRefreshResult {
  readonly status: AuthRefreshStatus;
  readonly pageUrl: string;
  readonly cookie?: CookieHealth;
  readonly message?: string;
}

export interface BrowserSessionHealth {
  readonly stage: BrowserStartupStage;
  readonly pageUrl?: string;
  readonly lastError?: string;
  readonly cookie?: CookieHealth;
  readonly updatedAt: string;
}

interface PageStreamEvent {
  readonly type: "idle" | "status" | "chunk" | "done" | "error" | "aborted";
  readonly status?: number;
  readonly text?: string;
  readonly message?: string;
  readonly name?: string;
}

interface StorageState {
  readonly cookies?: Cookie[];
  readonly origins?: unknown[];
}
const CRITICAL_GOOGLE_COOKIES = ["SID", "SSID", "HSID", "APISID", "SAPISID", "__Secure-1PSID", "__Secure-3PSID"] as const;
const COOKIE_SAVE_INTERVAL_MS = 15 * 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableFingerprint(profileDir: string): number {
  const prefix = createHash("sha256").update(profileDir).digest("hex").slice(0, 8);
  return 10_000 + (Number.parseInt(prefix, 16) % 90_000);
}

const GENERATE_RPC_PATH = /(?:^|\/)(?:[A-Za-z0-9_-]+\.)+GenerativeService(?:\/|\.)(?:Stream)?GenerateContent$/u;

export function isGenerateRequestUrl(rawUrl: string): boolean {
  try {
    const pathname = decodeURIComponent(new URL(rawUrl).pathname).replace(/\/+$/u, "");
    return GENERATE_RPC_PATH.test(pathname);
  } catch {
    return false;
  }
}

function isGenerateRequest(request: Request): boolean {
  return isGenerateRequestUrl(request.url());
}

/** 模板体必须是可解析的 JSON 数组；页面出错时可能发出表单编码的错误上报请求（trace=Error%2...），不能收作模板。 */
function isValidTemplateBody(body: string): boolean {
  try {
    return Array.isArray(JSON.parse(body));
  } catch {
    return false;
  }
}

function sanitizedHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !["host", "content-length"].includes(name.toLowerCase())));
}

export class NativeBrowserSession {
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  private snapshotKey: string | undefined;
  private bootstrapTemplate: CapturedTemplate | undefined;
  private readonly templates = new Map<string, CapturedTemplate>();
  private serial = Promise.resolve();
  private pendingOperations = 0;
  private lastActiveAt = Date.now();
  private idleTimer: NodeJS.Timeout | undefined;
  private authFile: string | undefined;
  private profileDir: string | undefined;
  private seedAuthOnNextLaunch = false;
  private health: BrowserSessionHealth = { stage: "idle", updatedAt: new Date().toISOString() };
  private runtimeLease: AccountRuntimeLease | undefined;
  private cookieHealth: CookieHealth | undefined;
  private lastCookieSaveAt = 0;
  constructor(
    authFile = settings.authFile,
    private readonly idleTimeoutMs = settings.browserIdleTimeoutMs,
  ) {
    this.authFile = authFile;
    this.profileDir = authFile ? join(dirname(authFile), "profile") : undefined;
  }

  getHealth(): BrowserSessionHealth {
    return { ...this.health, ...(this.cookieHealth ? { cookie: this.cookieHealth } : {}) };
  }

  private setHealth(stage: BrowserStartupStage, page?: Page, error?: unknown): void {
    this.health = {
      stage,
      ...(page && !page.isClosed() ? { pageUrl: page.url() } : {}),
      ...(error !== undefined ? { lastError: error instanceof Error ? error.message : String(error) } : {}),
      updatedAt: new Date().toISOString(),
    };
  }

  runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    this.pendingOperations += 1;
    this.cancelIdleClose();
    const guarded = (): Promise<T> => this.withWatchdog(operation);
    const result = this.serial.then(guarded, guarded);
    this.serial = result.then(() => undefined, () => undefined);
    void result.finally(() => {
      this.pendingOperations -= 1;
      this.lastActiveAt = Date.now();
      if (this.pendingOperations === 0) this.scheduleIdleClose();
    }).catch(() => undefined);
    return result;
  }

  /**
   * Browser operations can hang forever when the renderer freezes: the
   * in-page fetch abort timer only runs while the page's event loop is
   * alive, and Playwright's page.evaluate has no default timeout. Without
   * a watchdog, one wedged page blocks this session's serial queue for
   * every later request. Race each operation against a timeout; on expiry,
   * force-close the browser so hung evaluate promises reject and the next
   * queued operation starts on a fresh session.
   */
  private async withWatchdog<T>(operation: () => Promise<T>): Promise<T> {
    const timeoutMs = settings.browserWatchdogTimeoutMs;
    if (timeoutMs <= 0) return operation();
    let timer: NodeJS.Timeout | undefined;
    const expired: unique symbol = Symbol("browser-watchdog-expired");
    const outcome = await Promise.race([
      operation(),
      new Promise<symbol>((resolve) => {
        timer = setTimeout(() => resolve(expired), timeoutMs);
        timer.unref();
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    if (outcome !== expired) return outcome as T;
    await this.resetAfterWatchdog();
    throw new Error(
      `Browser session watchdog timed out after ${Math.round(timeoutMs / 1000)}s; the browser session was reset`,
    );
  }

  private async resetAfterWatchdog(): Promise<void> {
    try {
      // closeUnlocked() detaches the context before awaiting its shutdown,
      // so even a wedged browser process cannot block session recovery;
      // the extra race guards against context.close() itself hanging.
      await Promise.race([
        this.closeUnlocked(),
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 15_000);
          timer.unref();
        }),
      ]);
    } catch {
      // Recovery must never throw.
    }
  }

  private cancelIdleClose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private scheduleIdleClose(delayMs = this.idleTimeoutMs): void {
    this.cancelIdleClose();
    if (this.idleTimeoutMs <= 0 || this.pendingOperations > 0 || !this.context) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      this.enqueueIdleClose();
    }, Math.max(1, delayMs));
    this.idleTimer.unref();
  }

  private enqueueIdleClose(): void {
    const closeIfIdle = async (): Promise<void> => {
      if (this.pendingOperations > 0 || !this.context) return;
      const remainingMs = this.idleTimeoutMs - (Date.now() - this.lastActiveAt);
      if (remainingMs > 0) {
        this.scheduleIdleClose(remainingMs);
        return;
      }
      await this.closeUnlocked();
    };
    const result = this.serial.then(closeIfIdle, closeIfIdle);
    this.serial = result.then(() => undefined, () => undefined);
  }

  async warmup(): Promise<void> {
    await this.runExclusive(async () => { await this.ensureBotGuard(); });
  }

  async refreshAuth(): Promise<AuthRefreshResult> {
    return this.runExclusive(async () => {
      const context = await this.launchContextOnly().catch(() => undefined);
      const page = this.page;
      if (!context || !page || page.isClosed()) {
        return { status: "refresh_failed", pageUrl: "", message: "Browser context could not be launched for authentication refresh" };
      }
      const serviceLoginUrl = "https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Faistudio.google.com%2Fapp%2Fprompts%2Fnew_chat";
      try {
        this.setHealth("navigating", page);
        await page.goto(serviceLoginUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.waitForTimeout(3_000);
        const currentUrl = page.url();
        if (currentUrl.includes("accounts.google.com")) {
          const challenge = /challenge|speedbump|signin\/v2/iu.test(currentUrl);
          this.setHealth("failed", page, challenge ? "Google account challenge is required" : "Google reauthentication is required");
          return {
            status: challenge ? "challenge_required" : "reauth_required",
            pageUrl: currentUrl,
            ...(this.cookieHealth ? { cookie: this.cookieHealth } : {}),
          };
        }
        this.snapshotKey = undefined;
        this.bootstrapTemplate = undefined;
        this.templates.clear();
        await this.openAIStudio(page);
        await this.ensureBotGuardAttempt();
        await this.saveCookies(true);
        this.setHealth("healthy", page);
        return { status: "refreshed", pageUrl: page.url(), ...(this.cookieHealth ? { cookie: this.cookieHealth } : {}) };
      } catch (error) {
        this.setHealth("failed", page, error);
        await this.captureStartupDiagnostics(page, 5, error);
        return {
          status: "refresh_failed",
          pageUrl: page.isClosed() ? "" : page.url(),
          message: error instanceof Error ? error.message : String(error),
          ...(this.cookieHealth ? { cookie: this.cookieHealth } : {}),
        };
      }
    });
  }

  async captureTemplate(model: string): Promise<CapturedTemplate> {
    return this.runExclusive(async () => this.captureTemplateUnlocked(model));
  }

  async generateSnapshot(contents: readonly SnapshotContent[]): Promise<string> {
    return this.runExclusive(async () => {
      const page = await this.ensureBotGuard();
      const pieces: string[] = [];
      for (const content of contents) {
        for (const part of content.parts ?? []) {
          // WAA proof 绑定整段 prompt 的 SHA-256；每个 part 必须占一个位置，
          // function call/result、code、thought signature 等以空字符串占位。
          if (part.text !== undefined) {
            pieces.push(String(part.text));
            continue;
          }
          const inlineData = Array.isArray(part.inlineData) ? part.inlineData[1]
            : part.inlineData && "data" in part.inlineData ? part.inlineData.data
            : part.inline_data?.[1];
          if (inlineData !== undefined) {
            pieces.push(String(inlineData));
            continue;
          }
          const fileUri = Array.isArray(part.fileData) ? part.fileData[0]
            : part.fileData && "fileUri" in part.fileData ? part.fileData.fileUri
            : Array.isArray(part.file_data) ? part.file_data[0]
            : part.file_data && "file_uri" in part.file_data ? part.file_data.file_uri
            : undefined;
          if (fileUri !== undefined) {
            pieces.push(String(fileUri));
            continue;
          }
          pieces.push("");
        }
      }
      const hash = createHash("sha256").update(pieces.join(" ")).digest("hex");
      const result = await page.evaluate(async (contentHash) => {
        const win = window as unknown as Record<string, unknown>;
        const dms = win.default_MakerSuite as Record<string, (...args: unknown[]) => unknown> | undefined;
        const key = win.__snap_key;
        const service = win.__bg_service;
        if (!dms || typeof key !== "string" || typeof dms[key] !== "function" || !service) {
          throw new Error("BotGuard snapshot service is unavailable");
        }
        return String(await dms[key](service, contentHash) || "");
      }, hash);
      if (!result) throw new Error("BotGuard snapshot generation returned an empty value");
      return result;
    });
  }

  async replay(body: string, timeoutMs = settings.browserTimeoutMs, signal?: AbortSignal): Promise<{ status: number; body: string }> {
    return this.runExclusive(async () => {
      if (signal?.aborted) throw Object.assign(new Error("Native gateway request aborted"), { name: "AbortError" });
      const page = await this.ensureBotGuard();
      const template = this.firstTemplate();
      const requestId = createHash("sha256").update(`${Date.now()}:${Math.random()}`).digest("hex").slice(0, 16);
      const abortFetch = (): void => {
        void page.evaluate((id) => {
          const win = window as unknown as Record<string, unknown>;
          const fetches = win.__aistudioFetches as Record<string, AbortController> | undefined;
          fetches?.[id]?.abort();
        }, requestId).catch(() => undefined);
      };
      signal?.addEventListener("abort", abortFetch, { once: true });
      try {
        return await page.evaluate(async (args) => {
          const win = window as unknown as Record<string, unknown>;
          const fetches = (win.__aistudioFetches ??= {}) as Record<string, AbortController>;
          const controller = new AbortController();
          fetches[args.requestId] = controller;
          const timer = setTimeout(() => controller.abort(), args.timeoutMs);
          try {
            const response = await fetch(args.url, {
              method: "POST",
              credentials: "include",
              headers: args.headers,
              body: args.body,
              signal: controller.signal,
            });
            return { status: response.status, body: await response.text() };
          } finally {
            clearTimeout(timer);
            delete fetches[args.requestId];
          }
        }, { url: template.url, headers: template.headers, body, timeoutMs, requestId });
      } catch (error) {
        if (signal?.aborted) throw Object.assign(new Error("Native gateway request aborted"), { name: "AbortError" });
        throw error;
      } finally {
        signal?.removeEventListener("abort", abortFetch);
      }
    });
  }

  async replayStream(
    body: string,
    onChunk: (chunk: string) => void,
    signal?: AbortSignal,
    timeoutMs = settings.browserTimeoutMs,
  ): Promise<{ status: number; body: string }> {
    return this.runExclusive(async () => {
      const page = await this.ensureBotGuard();
      const template = this.firstTemplate();
      const requestId = createHash("sha256").update(`${Date.now()}:${Math.random()}`).digest("hex").slice(0, 16);
      const startPageFetch = (): Promise<unknown> =>
        page.evaluate((args) => {
        const win = window as unknown as Record<string, unknown>;
        const streams = (win.__aistudioStreams ??= {}) as Record<string, {
          controller: AbortController;
          events: PageStreamEvent[];
          waiter: ((event: PageStreamEvent) => void) | null;
        }>;
        const state: {
          controller: AbortController;
          events: PageStreamEvent[];
          waiter: ((event: PageStreamEvent) => void) | null;
        } = { controller: new AbortController(), events: [], waiter: null };
        delete streams[args.requestId];
        streams[args.requestId] = state;
        const push = (event: PageStreamEvent): void => {
          if (state.waiter) {
            const waiter = state.waiter;
            state.waiter = null;
            waiter(event);
          } else {
            state.events.push(event);
          }
        };
        void (async () => {
          const timer = setTimeout(() => state.controller.abort(), args.timeoutMs);
          try {
            const response = await fetch(args.url, {
              method: "POST",
              credentials: "include",
              headers: args.headers,
              body: args.body,
              signal: state.controller.signal,
            });
            push({ type: "status", status: response.status });
            if (!response.body) {
              const text = await response.text();
              if (text) push({ type: "chunk", text });
            } else {
              const reader = response.body.getReader();
              const decoder = new TextDecoder();
              for (;;) {
                const item = await reader.read();
                if (item.done) break;
                const text = decoder.decode(item.value, { stream: true });
                if (text) push({ type: "chunk", text });
              }
              const tail = decoder.decode();
              if (tail) push({ type: "chunk", text: tail });
            }
            push({ type: "done" });
          } catch (error) {
            if (state.controller.signal.aborted) push({ type: "aborted" });
            else push({ type: "error", message: String(error), ...(error instanceof Error ? { name: error.name } : {}) });
          } finally {
            clearTimeout(timer);
          }
        })();
        }, { requestId, url: template.url, headers: template.headers, body, timeoutMs });
      await startPageFetch();

      let status = 0;
      let retriedNetworkError = false;
      let responseBody = "";
      const pending: string[] = [];
      const deadline = Date.now() + timeoutMs;
      try {
        while (Date.now() < deadline) {
          if (signal?.aborted) {
            await this.abortPageStream(page, requestId);
            throw Object.assign(new Error("Native gateway request aborted"), { name: "AbortError" });
          }
          const event = await page.evaluate(async ({ id, waitMs }) => {
            const streams = (window as unknown as Record<string, unknown>).__aistudioStreams as Record<string, {
              events: PageStreamEvent[];
              waiter: ((event: PageStreamEvent) => void) | null;
            }> | undefined;
            const state = streams?.[id];
            if (!state) return { type: "error", message: "stream state disappeared" } satisfies PageStreamEvent;
            const queued = state.events.shift();
            if (queued) return queued;
            return new Promise<PageStreamEvent>((resolve) => {
              let settled = false;
              const finish = (value: PageStreamEvent): void => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (state.waiter === finish) state.waiter = null;
                resolve(value);
              };
              const timer = setTimeout(() => finish({ type: "idle" }), waitMs);
              state.waiter = finish;
            });
          }, { id: requestId, waitMs: 250 }) as PageStreamEvent;
          if (event.type === "idle") continue;
          if (event.type === "status") {
            status = event.status ?? 0;
            if (status >= 200 && status < 300) {
              for (const chunk of pending.splice(0)) onChunk(chunk);
            }
            continue;
          }
          if (event.type === "chunk") {
            const text = event.text ?? "";
            responseBody += text;
            if (status >= 200 && status < 300) onChunk(text);
            else if (status === 0) pending.push(text);
            continue;
          }
          if (event.type === "done") return { status, body: responseBody };
          if (event.type === "aborted") {
            throw Object.assign(new Error("Native gateway request aborted"), { name: "AbortError" });
          }
          if (event.type === "error") {
            const message = event.message ?? "unknown error";
            const isNetworkError = message.includes("Failed to fetch")
              || message.includes("Network request failed")
              || event.name === "NetworkError";
            if (isNetworkError && !retriedNetworkError && !signal?.aborted) {
              // 网络级失败（代理抖动、连接被重置、模板凭据瞬时失效）重试一次，
              // 避免把短暂抖动直接抛给客户端。
              retriedNetworkError = true;
              console.warn(`[browser-session] streaming fetch failed at network level, retrying once: ${message} (page=${page.url()})`);
              status = 0;
              responseBody = "";
              pending.length = 0;
              await this.abortPageStream(page, requestId);
              await startPageFetch();
              continue;
            }
            const online = await page.evaluate(() => navigator.onLine).catch(() => undefined);
            console.error(`[browser-session] streaming request failed: ${message} (page=${page.url()}, online=${online}, name=${event.name ?? "n/a"})`);
            throw new Error(`AI Studio streaming request failed: ${message}`);
          }
        }
        await this.abortPageStream(page, requestId);
        throw new Error("AI Studio streaming request timed out");
      } finally {
        // On the normal "done" path this abort is a no-op; on exception paths
        // (onChunk throwing, parser errors) it stops the in-page fetch that
        // would otherwise keep running until the timeout with no consumer.
        await this.abortPageStream(page, requestId);
        await page.evaluate((id) => {
          const win = window as unknown as Record<string, unknown>;
          const streams = win.__aistudioStreams as Record<string, unknown> | undefined;
          if (streams) delete streams[id];
        }, requestId).catch(() => undefined);
      }
    });
  }

  async pageFetch(url: string, headers: Readonly<Record<string, string>>, body: string): Promise<{ status: number; body: string }> {
    return this.runExclusive(async () => {
      await this.ensureContext();
      const page = this.page;
      if (!page) throw new Error("Native browser page is unavailable");
      return page.evaluate(async (args) => {
        const response = await fetch(args.url, {
          method: "POST",
          credentials: "include",
          headers: args.headers,
          body: args.body,
        });
        return { status: response.status, body: await response.text() };
      }, { url, headers, body });
    });
  }

  async cookies(): Promise<Cookie[]> {
    return this.runExclusive(async () => {
      const context = await this.ensureContext();
      return context.cookies();
    });
  }

  async inspectAccountProfile(): Promise<AccountProfile> {
    return this.runExclusive(async () => {
      const context = await this.ensureContext();
      const page = this.page;
      if (!page) throw new Error("Native browser page is unavailable");
      const aiStudio = await page.evaluate(() => {
        const text = (element: Element | null): string => (element?.textContent ?? "").replace(/\s+/gu, " ").trim();
        const headers = Array.from(document.querySelectorAll("header, [role='banner'], nav"))
          .map(element => (element as HTMLElement).innerText?.trim() || text(element))
          .filter(Boolean)
          .join("\n");
        return {
          ai_studio_header: headers.slice(0, 8_000),
          ai_studio_body: (document.body?.innerText ?? "").slice(0, 20_000),
          image_urls: Array.from(document.images).map(image => image.currentSrc || image.src).filter(Boolean).slice(0, 80),
        };
      });

      const profilePage = await context.newPage();
      let profile: { profile_text?: string; profile_heading?: string | undefined; subscription_text?: string; image_urls?: string[] } = {};
      try {
        await profilePage.goto("https://myaccount.google.com/", { waitUntil: "domcontentloaded", timeout: 30_000 });
        await profilePage.waitForTimeout(1_000);
        profile = await profilePage.evaluate(() => ({
          profile_text: (document.body?.innerText ?? "").slice(0, 20_000),
          profile_heading: document.querySelector("h1, [role='heading']")?.textContent?.replace(/\s+/gu, " ").trim() || undefined,
          image_urls: Array.from(document.images).map(image => image.currentSrc || image.src).filter(Boolean).slice(0, 80),
        }));
        try {
          await profilePage.goto("https://myaccount.google.com/subscriptions", { waitUntil: "domcontentloaded", timeout: 30_000 });
          await profilePage.waitForTimeout(1_500);
          const subscriptionText = await profilePage.evaluate(() => (document.body?.innerText ?? "").slice(0, 20_000));
          if (subscriptionText) profile.subscription_text = subscriptionText;
        } catch {
          // The account page remains a valid source when subscriptions are unavailable.
        }
      } catch {
        // AI Studio header data is still useful when the account page is unavailable.
      } finally {
        await profilePage.close().catch(() => undefined);
      }
      return parseAccountProfileSnapshot({
        ...aiStudio,
        ...(profile.profile_text !== undefined ? { profile_text: profile.profile_text } : {}),
        ...(profile.profile_heading !== undefined ? { profile_heading: profile.profile_heading } : {}),
        ...(profile.subscription_text !== undefined ? { subscription_text: profile.subscription_text } : {}),
        image_urls: [...aiStudio.image_urls, ...(profile.image_urls ?? [])],
      });
    });
  }

  async probeFunctionCallingUi(outputDir: string, model?: string): Promise<Record<string, unknown>> {
    return this.runExclusive(async () => {
      const page = await this.ensureBotGuard();
      if (model) {
        const url = new URL(page.url());
        url.searchParams.set("model", model.replace(/^models\//u, ""));
        await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.locator("textarea").first().waitFor({ state: "attached", timeout: 60_000 });
      }
      await mkdir(outputDir, { recursive: true });
      for (const toolId of ["searchAsAToolTooltip", "codeExecutionTooltip", "browseAsAToolTooltip", "googleMapsTooltip"]) {
        const builtinToggle = page.locator(`[data-test-id="${toolId}"] button[role="switch"]`).first();
        if (await builtinToggle.count() && await builtinToggle.getAttribute("aria-checked") === "true") {
          await builtinToggle.click();
          await page.waitForTimeout(300);
        }
      }
      const container = page.locator('[data-test-id="functionCallingTooltip"]');
      const toggle = container.locator('button[role="switch"]');
      const editButton = page.locator('button.edit-function-declarations-button');
      if (await toggle.count() && await toggle.first().isEnabled() && await toggle.first().getAttribute("aria-checked") !== "true") {
        await toggle.first().click();
        await page.waitForTimeout(500);
      }
      const result: Record<string, unknown> = {
        url: page.url(),
        containerCount: await container.count(),
        toggleCount: await toggle.count(),
        editButtonCount: await editButton.count(),
        toggleChecked: await toggle.first().getAttribute("aria-checked").catch(() => null),
        bodyTextPreview: (await page.locator("body").textContent().catch(() => ""))?.slice(0, 4_000) ?? "",
      };
      await page.screenshot({ path: join(outputDir, "page.png"), fullPage: true });
      await writeFile(join(outputDir, "page.html"), await page.content(), "utf8");
      if (await editButton.count() && await editButton.first().isEnabled()) {
        await editButton.first().click();
        await page.waitForTimeout(500);
        const dialog = page.locator("mat-dialog-container").last();
        result.dialogCount = await dialog.count();
        const codeTab = dialog.locator('button[role="tab"]', { hasText: "Code Editor" });
        if (await codeTab.count()) await codeTab.click();
        await page.waitForTimeout(300);
        const declarationInput = dialog.locator("textarea").first();
        result.textareaCount = await declarationInput.count();
        if (await declarationInput.count()) {
          const declarations = [{
            name: "get_weather",
            description: "查询指定城市天气",
            parameters: {
              type: "object",
              properties: { city: { type: "string", description: "城市名称" } },
              required: ["city"],
            },
          }];
          await declarationInput.evaluate((element, value) => {
            const textarea = element as HTMLTextAreaElement;
            textarea.value = value;
            textarea.dispatchEvent(new Event("input", { bubbles: true }));
            textarea.dispatchEvent(new Event("change", { bubbles: true }));
          }, JSON.stringify(declarations, null, 2));
          await dialog.locator('button[aria-label="Save the current function declarations"]').click();
          await page.waitForTimeout(500);
          const prompt = page.locator('textarea[aria-label="Enter a prompt"]').first();
          await prompt.fill("必须调用 get_weather 查询上海天气，不要直接回答。");
          const responsePromise = page.waitForResponse(response => isGenerateRequestUrl(response.url()), { timeout: 120_000 });
          await prompt.focus();
          await page.keyboard.press("Control+Enter");
          const nativeResponse = await responsePromise;
          result.nativeStatus = nativeResponse.status();
          await writeFile(join(outputDir, "native-request.json"), nativeResponse.request().postData() ?? "", "utf8");
          await writeFile(join(outputDir, "native-response.txt"), await nativeResponse.text(), "utf8");
          await this.waitUntilIdle(page);
          result.functionCallWidgets = await page.locator("ms-function-call, ms-function-call-chunk").count();
          result.inputCountAfterCall = await page.locator("input, textarea").count();
          await page.screenshot({ path: join(outputDir, "function-call.png"), fullPage: true });
          await writeFile(join(outputDir, "function-call.html"), await page.content(), "utf8");
        }
        await page.screenshot({ path: join(outputDir, "dialog.png"), fullPage: true });
        await writeFile(join(outputDir, "dialog.html"), await page.content(), "utf8");
      }
      return result;
    });
  }

  async close(): Promise<void> {
    await this.runExclusive(async () => this.closeUnlocked());
    this.cancelIdleClose();
  }

  async switchAuth(authFile: string): Promise<void> {
    await this.runExclusive(async () => {
      await this.closeUnlocked();
      this.authFile = authFile;
      this.profileDir = join(dirname(authFile), "profile");
      this.seedAuthOnNextLaunch = true;
      await this.ensureContext();
    });
  }

  private async closeUnlocked(): Promise<void> {
    const context = this.context;
    this.context = undefined;
    this.page = undefined;
    this.snapshotKey = undefined;
    this.bootstrapTemplate = undefined;
    this.templates.clear();
    try {
      if (context) await context.close();
      if (this.profileDir) await cleanBrowserCaches(this.profileDir).catch(() => undefined);
    } finally {
      await this.runtimeLease?.release().catch(() => undefined);
      this.runtimeLease = undefined;
      this.setHealth("idle");
    }
  }

  private async abortPageStream(page: Page, requestId: string): Promise<void> {
    await page.evaluate((id) => {
      const streams = (window as unknown as Record<string, unknown>).__aistudioStreams as Record<string, { controller?: AbortController }> | undefined;
      streams?.[id]?.controller?.abort();
    }, requestId).catch(() => undefined);
  }

  private async launchContextOnly(): Promise<BrowserContext> {
    if (this.context && this.page && !this.page.isClosed()) return this.context;
    if (!this.profileDir) throw new Error("AISTUDIO_AUTH_FILE is required by the native browser gateway");
    this.setHealth("launching");
    this.runtimeLease ??= await AccountRuntimeLease.acquire(join(dirname(this.profileDir), "runtime.lock"));
    await cleanBrowserCaches(this.profileDir).catch(() => undefined);
    const context = await launchPersistentContext({
      userDataDir: this.profileDir,
      headless: settings.browserHeadless,
      stealthArgs: false,
      args: [
        `--fingerprint=${stableFingerprint(this.profileDir)}`,
        "--fingerprint-platform=windows",
        ...(!settings.browserHeadless ? ["--start-maximized", "--ignore-gpu-blocklist"] : []),
      ],
      ...(settings.proxyUrl ? { proxy: settings.proxyUrl } : {}),
      ...(!settings.browserHeadless ? { viewport: null } : {}),
    });
    this.context = context;
    this.page = context.pages()[0] ?? await context.newPage();
    await this.seedFreshProfile(context);
    return context;
  }

  private async ensureContext(): Promise<BrowserContext> {
    if (this.context && this.page && !this.page.isClosed() && this.snapshotKey) return this.context;
    const context = await this.launchContextOnly();
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const page = attempt === 0 ? context.pages()[0] ?? await context.newPage() : await context.newPage();
      this.page = page;
      try {
        await this.openAIStudio(page);
        this.setHealth("healthy", page);
        return context;
      } catch (error) {
        lastError = error;
        this.setHealth("failed", page, error);
        await this.captureStartupDiagnostics(page, attempt + 1, error);
        await page.close().catch(() => undefined);
        if (this.page === page) this.page = undefined;
      }
    }
    await this.closeUnlocked().catch(() => undefined);
    this.setHealth("failed", undefined, lastError);
    throw new Error(`Failed to initialize AI Studio after rebuilding the page once: ${String(lastError)}`);
  }

  private async captureStartupDiagnostics(page: Page, attempt: number, error: unknown): Promise<void> {
    if (!this.authFile) return;
    const outputDir = join(dirname(this.authFile), "startup-diagnostics");
    await mkdir(outputDir, { recursive: true }).catch(() => undefined);
    const bodyPreview = await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
    const diagnostic = {
      attempt,
      stage: this.health.stage,
      url: page.isClosed() ? undefined : page.url(),
      error: error instanceof Error ? error.message : String(error),
      bodyPreview: bodyPreview.slice(0, 2_000),
      capturedAt: new Date().toISOString(),
    };
    await writeFile(join(outputDir, `attempt-${attempt}.json`), JSON.stringify(diagnostic, null, 2), "utf8").catch(() => undefined);
    if (!page.isClosed()) {
      await page.screenshot({ path: join(outputDir, `attempt-${attempt}.png`), fullPage: true, timeout: 5_000 }).catch(() => undefined);
    }
  }

  private async seedFreshProfile(context: BrowserContext): Promise<void> {
    if (!this.authFile) return;
    const existing = await context.cookies();
    if (existing.length > 0 && !this.seedAuthOnNextLaunch) return;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.authFile, "utf8"));
      if (!isRecord(parsed) || !Array.isArray(parsed.cookies) || parsed.cookies.length === 0) return;
      await context.addCookies(parsed.cookies as Cookie[]);
      this.seedAuthOnNextLaunch = false;
      const page = this.page ?? await context.newPage();
      await page.goto(GOOGLE_LOGIN_BOOTSTRAP_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForTimeout(3_000);
    } catch (error) {
      throw new Error(`Failed to seed native browser profile from auth file: ${String(error)}`);
    }
  }

  private async openAIStudio(page: Page): Promise<void> {
    let lastError: unknown;
    for (const url of AI_STUDIO_URLS) {
      try {
        this.setHealth("navigating", page);
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        if (page.url().includes("accounts.google.com")) throw new Error("Google cookies are expired");
        this.setHealth("authenticated", page);
        await page.waitForFunction(() => Boolean((window as unknown as Record<string, unknown>).default_MakerSuite), undefined, { timeout: 60_000 });
        await page.locator("textarea").first().waitFor({ state: "attached", timeout: 60_000 });
        this.setHealth("makersuite_ready", page);
        await this.saveCookies();
        await this.installHooks(page);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(`Failed to open AI Studio: ${String(lastError)}`);
  }

  private async installHooks(page: Page): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const result = await page.evaluate(INSTALL_HOOKS_JS) as unknown;
      if (result === "already_hooked") {
        this.setHealth("hooks_installed", page);
        return;
      }
      if (typeof result === "string" && result.startsWith("hooked:")) {
        this.snapshotKey = result.slice("hooked:".length);
        this.setHealth("hooks_installed", page);
        return;
      }
      await page.waitForTimeout(2_000);
    }
    throw new Error(`Failed to install AI Studio hooks at ${page.url()}`);
  }

  private async ensureBotGuard(): Promise<Page> {
    try {
      return await this.ensureBotGuardAttempt();
    } catch (error) {
      const failedPage = this.page;
      if (failedPage) await this.captureStartupDiagnostics(failedPage, 3, error);
      await failedPage?.close().catch(() => undefined);
      const context = this.context;
      if (!context) throw error;
      const rebuiltPage = await context.newPage();
      this.page = rebuiltPage;
      try {
        await this.openAIStudio(rebuiltPage);
        return await this.ensureBotGuardAttempt();
      } catch (retryError) {
        this.setHealth("failed", rebuiltPage, retryError);
        await this.captureStartupDiagnostics(rebuiltPage, 4, retryError);
        throw new Error(`Failed to initialize AI Studio BotGuard after rebuilding the page once: ${String(retryError)}`);
      }
    }
  }

  private async ensureBotGuardAttempt(): Promise<Page> {
    await this.ensureContext();
    const page = this.page;
    if (!page) throw new Error("Native browser page is unavailable");
    await this.installHooks(page);
    const ready = await page.evaluate(() => Boolean((window as unknown as Record<string, unknown>).__bg_service));
    if (ready) {
      this.setHealth("botguard_ready", page);
      await this.saveCookies();
      return page;
    }

    let captured: CapturedTemplate | undefined;
    const onRequest = (request: Request): void => {
      if (captured || !isGenerateRequest(request)) return;
      const body = request.postData();
      if (body && isValidTemplateBody(body)) captured = { url: request.url(), headers: sanitizedHeaders(request.headers()), body };
    };
    page.on("request", onRequest);
    const textarea = page.locator("textarea").first();
    const original = await textarea.inputValue().catch(() => "");
    try {
      await page.evaluate(DIALOG_CLEANUP_JS);
      await textarea.fill("say '1'");
      await page.waitForTimeout(800);
      await textarea.focus();
      await page.keyboard.press("Control+Enter");
      await page.waitForFunction(() => Boolean((window as unknown as Record<string, unknown>).__bg_service), undefined, { timeout: 45_000 });
      await this.waitUntilIdle(page);
      if (captured) this.bootstrapTemplate = await this.withTimezone(page, captured);
      this.setHealth("botguard_ready", page);
      await this.saveCookies();
      return page;
    } finally {
      page.off("request", onRequest);
      await textarea.fill(original).catch(() => undefined);
    }
  }

  private async captureTemplateUnlocked(model: string): Promise<CapturedTemplate> {
    const cached = this.templates.get(model);
    if (cached) {
      // 自愈：坏模板（历史版本可能缓存过错误上报请求体）丢弃后重新捕获
      if (isValidTemplateBody(cached.body)) return cached;
      this.templates.delete(model);
    }
    const page = await this.ensureBotGuard();
    const modelId = model.replace(/^models\//u, "");
    const currentUrl = new URL(page.url());
    if (currentUrl.searchParams.get("model") !== modelId) {
      currentUrl.searchParams.set("model", modelId);
      await page.goto(currentUrl.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.locator("textarea").first().waitFor({ state: "attached", timeout: 60_000 });
      await page.waitForTimeout(1_000);
    }
    let captured: CapturedTemplate | undefined;
    const onRequest = (request: Request): void => {
      if (process.env.AISTUDIO_DEBUG_CAPTURE === "1" && /Generate|Stream|Count|Quota/iu.test(request.url())) {
        console.error(`[capture] ${request.method()} ${request.url()} body=${request.postData()?.slice(0, 80) ?? ""}`);
      }
      if (captured || !isGenerateRequest(request)) return;
      const body = request.postData();
      if (body && body.length > 100 && isValidTemplateBody(body)) captured = { url: request.url(), headers: sanitizedHeaders(request.headers()), body };
    };
    page.on("request", onRequest);
    const textarea = page.locator("textarea").first();
    const original = await textarea.inputValue().catch(() => "");
    try {
      await textarea.fill("say 't'");
      await textarea.focus();
      await page.keyboard.press("Control+Enter");
      const deadline = Date.now() + 30_000;
      while (!captured && Date.now() < deadline) await page.waitForTimeout(250);
      if (!captured) {
        if (process.env.AISTUDIO_DEBUG_CAPTURE === "1" && this.authFile) {
          const debugDir = dirname(this.authFile);
          await page.screenshot({ path: join(debugDir, "capture-timeout.png"), fullPage: true }).catch(() => undefined);
          await writeFile(join(debugDir, "capture-timeout.html"), await page.content(), "utf8").catch(() => undefined);
        }
        throw new Error(`Timed out capturing GenerateContent template for ${model}`);
      }
      await this.waitUntilIdle(page);
      const template = await this.withTimezone(page, captured);
      this.templates.set(model, template);
      return template;
    } finally {
      page.off("request", onRequest);
      await textarea.fill(original).catch(() => undefined);
    }
  }

  private async pageTimezone(page: Page): Promise<string | undefined> {
    const timezone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone).catch(() => undefined);
    return typeof timezone === "string" && timezone ? timezone : undefined;
  }

  private async withTimezone(page: Page, captured: CapturedTemplate): Promise<CapturedTemplate> {
    const timezone = await this.pageTimezone(page);
    return timezone ? { ...captured, timezone } : captured;
  }

  private firstTemplate(): CapturedTemplate {
    const template = this.templates.values().next().value as CapturedTemplate | undefined;
    if (template) return template;
    if (this.bootstrapTemplate) return this.bootstrapTemplate;
    throw new Error("No captured GenerateContent template is available");
  }

  private async waitUntilIdle(page: Page): Promise<void> {
    await page.waitForFunction(() => {
      const stop = [...document.querySelectorAll("button")].some(button => button.textContent?.trim() === "Stop");
      return !stop && Boolean(document.querySelector("button.ctrl-enter-submits"));
    }, undefined, { timeout: 60_000 });
  }

  private async saveCookies(force = false): Promise<void> {
    if (!this.authFile || !this.context) return;
    const now = Date.now();
    if (!force && now - this.lastCookieSaveAt < COOKIE_SAVE_INTERVAL_MS) return;
    const cookies = await this.context.cookies();
    const names = new Set(cookies.map(cookie => cookie.name));
    const expiries = cookies.map(cookie => cookie.expires).filter(expires => expires > 0);
    const earliestExpirySeconds = expiries.length > 0 ? Math.min(...expiries) : undefined;
    this.cookieHealth = {
      criticalPresent: CRITICAL_GOOGLE_COOKIES.filter(name => names.has(name)).length,
      criticalMissing: CRITICAL_GOOGLE_COOKIES.filter(name => !names.has(name)),
      persistentCookies: expiries.length,
      ...(earliestExpirySeconds !== undefined ? {
        earliestExpiry: new Date(earliestExpirySeconds * 1_000).toISOString(),
        expiringWithinDays: Math.max(0, Math.floor((earliestExpirySeconds * 1_000 - now) / 86_400_000)),
      } : {}),
      checkedAt: new Date(now).toISOString(),
    };
    const state: StorageState = { cookies, origins: [] };
    const temporary = `${this.authFile}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2), "utf8");
    await rename(temporary, this.authFile);
    this.lastCookieSaveAt = now;
  }
}

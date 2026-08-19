import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { launchPersistentContext } from "cloakbrowser";
import type { BrowserContext, Cookie, Page, Request } from "playwright-core";
import { settings } from "../config.js";
import { parseAccountProfileSnapshot, type AccountProfile } from "../accounts/account-profile.js";
import { AI_STUDIO_URLS, DIALOG_CLEANUP_JS, GOOGLE_LOGIN_BOOTSTRAP_URL, INSTALL_HOOKS_JS } from "./hooks.js";

export interface CapturedTemplate {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface SnapshotContent {
  readonly parts?: readonly {
    readonly text?: unknown;
    readonly inlineData?: { readonly data?: unknown } | readonly [unknown, unknown];
    readonly inline_data?: readonly unknown[];
  }[];
}

interface PageStreamEvent {
  readonly type: "idle" | "status" | "chunk" | "done" | "error" | "aborted";
  readonly status?: number;
  readonly text?: string;
  readonly message?: string;
}

interface StorageState {
  readonly cookies?: Cookie[];
  readonly origins?: unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableFingerprint(profileDir: string): number {
  const prefix = createHash("sha256").update(profileDir).digest("hex").slice(0, 8);
  return 10_000 + (Number.parseInt(prefix, 16) % 90_000);
}

function isGenerateRequest(request: Request): boolean {
  return request.url().includes("GenerateContent") && !request.url().includes("Count");
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
  private authFile: string | undefined;
  private profileDir: string | undefined;

  constructor(
    authFile = settings.authFile,
  ) {
    this.authFile = authFile;
    this.profileDir = authFile ? join(dirname(authFile), "profile") : undefined;
  }

  runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation, operation);
    this.serial = result.then(() => undefined, () => undefined);
    return result;
  }

  async warmup(): Promise<void> {
    await this.runExclusive(async () => { await this.ensureBotGuard(); });
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
          if (part.text !== undefined) pieces.push(String(part.text));
          if (Array.isArray(part.inlineData) && part.inlineData[1] !== undefined) pieces.push(String(part.inlineData[1]));
          else if (part.inlineData && "data" in part.inlineData && part.inlineData.data !== undefined) pieces.push(String(part.inlineData.data));
          if (part.inline_data?.[1] !== undefined) pieces.push(String(part.inline_data[1]));
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
      await page.evaluate((args) => {
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
            else push({ type: "error", message: String(error) });
          } finally {
            clearTimeout(timer);
          }
        })();
      }, { requestId, url: template.url, headers: template.headers, body, timeoutMs });

      let status = 0;
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
          throw new Error(`AI Studio streaming request failed: ${event.message ?? "unknown error"}`);
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

  async close(): Promise<void> {
    await this.runExclusive(async () => this.closeUnlocked());
  }

  async switchAuth(authFile: string): Promise<void> {
    await this.runExclusive(async () => {
      await this.closeUnlocked();
      this.authFile = authFile;
      this.profileDir = join(dirname(authFile), "profile");
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
    if (context) await context.close();
  }

  private async abortPageStream(page: Page, requestId: string): Promise<void> {
    await page.evaluate((id) => {
      const streams = (window as unknown as Record<string, unknown>).__aistudioStreams as Record<string, { controller?: AbortController }> | undefined;
      streams?.[id]?.controller?.abort();
    }, requestId).catch(() => undefined);
  }

  private async ensureContext(): Promise<BrowserContext> {
    if (this.context && this.page && !this.page.isClosed()) return this.context;
    if (!this.profileDir) throw new Error("AISTUDIO_AUTH_FILE is required by the native browser gateway");
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
    await this.openAIStudio(this.page);
    return context;
  }

  private async seedFreshProfile(context: BrowserContext): Promise<void> {
    if (!this.authFile) return;
    const existing = await context.cookies();
    if (existing.length > 0) return;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.authFile, "utf8"));
      if (!isRecord(parsed) || !Array.isArray(parsed.cookies) || parsed.cookies.length === 0) return;
      await context.addCookies(parsed.cookies as Cookie[]);
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
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        if (page.url().includes("accounts.google.com")) throw new Error("Google cookies are expired");
        await page.waitForFunction(() => Boolean((window as unknown as Record<string, unknown>).default_MakerSuite), undefined, { timeout: 60_000 });
        await page.locator("textarea").first().waitFor({ state: "attached", timeout: 60_000 });
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
      if (result === "already_hooked") return;
      if (typeof result === "string" && result.startsWith("hooked:")) {
        this.snapshotKey = result.slice("hooked:".length);
        return;
      }
      await page.waitForTimeout(2_000);
    }
    throw new Error(`Failed to install AI Studio hooks at ${page.url()}`);
  }

  private async ensureBotGuard(): Promise<Page> {
    await this.ensureContext();
    const page = this.page;
    if (!page) throw new Error("Native browser page is unavailable");
    await this.installHooks(page);
    const ready = await page.evaluate(() => Boolean((window as unknown as Record<string, unknown>).__bg_service));
    if (ready) return page;

    let captured: CapturedTemplate | undefined;
    const onRequest = (request: Request): void => {
      if (captured || !isGenerateRequest(request)) return;
      const body = request.postData();
      if (body) captured = { url: request.url(), headers: sanitizedHeaders(request.headers()), body };
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
      if (captured) this.bootstrapTemplate = captured;
      return page;
    } finally {
      page.off("request", onRequest);
      await textarea.fill(original).catch(() => undefined);
    }
  }

  private async captureTemplateUnlocked(model: string): Promise<CapturedTemplate> {
    const cached = this.templates.get(model);
    if (cached) return cached;
    const page = await this.ensureBotGuard();
    if (this.bootstrapTemplate) {
      this.templates.set(model, this.bootstrapTemplate);
      return this.bootstrapTemplate;
    }
    let captured: CapturedTemplate | undefined;
    const onRequest = (request: Request): void => {
      if (captured || !isGenerateRequest(request)) return;
      const body = request.postData();
      if (body && body.length > 100) captured = { url: request.url(), headers: sanitizedHeaders(request.headers()), body };
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
      if (!captured) throw new Error(`Timed out capturing GenerateContent template for ${model}`);
      await this.waitUntilIdle(page);
      this.templates.set(model, captured);
      return captured;
    } finally {
      page.off("request", onRequest);
      await textarea.fill(original).catch(() => undefined);
    }
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

  private async saveCookies(): Promise<void> {
    if (!this.authFile || !this.context) return;
    const state: StorageState = { cookies: await this.context.cookies(), origins: [] };
    await writeFile(this.authFile, JSON.stringify(state, null, 2), "utf8");
  }
}

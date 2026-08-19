import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import fastifyStatic from "@fastify/static";
import { parse, stringify } from "yaml";
import { ApiKeyStore } from "./auth/api-key-store.js";
import { BridgeError, type BackendBridge } from "./bridge/backend-bridge.js";
import { NativeBackendBridge } from "./bridge/native-bridge.js";
import { RuntimeConfigStore } from "./config/runtime-config.js";
import { settings } from "./config.js";
import { HttpError, errorDetail } from "./http/errors.js";
import { InteractionStore } from "./interactions/store.js";
import type { BuiltinToolName } from "./interactions/types.js";

interface AppServices {
  readonly bridge: BackendBridge;
  readonly apiKeys: ApiKeyStore;
  readonly interactions: InteractionStore;
}

interface BuildAppOptions {
  readonly services?: Partial<AppServices>;
  readonly logger?: boolean;
  readonly serveStatic?: boolean;
  readonly runtimeConfigFile?: string;
}

const FALLBACK_MODELS = [
  "gemma-4-31b-it",
  "gemma-4-26b-a4b-it",
  "gemini-3-flash-preview",
  "gemini-3.5-flash",
  "gemini-3.1-pro-preview",
  "gemini-3.1-flash-lite",
  "gemini-3.1-flash-lite-image",
  "gemini-3.1-flash-image",
  "gemini-3-pro-image",
  "gemini-2.5-flash-image",
  "gemini-3.1-flash-tts-preview",
  "gemini-pro-latest",
  "gemini-flash-latest",
  "gemini-flash-lite-latest",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const BUILTIN_TOOL_NAMES = ["google_search", "code_execution", "google_maps", "url_context"] as const satisfies readonly BuiltinToolName[];
// The marker is added by the same-origin WebUI. API keys authenticate requests
// but no longer grant or configure access to AI Studio's built-in tools.
const WEB_UI_HEADER = "x-aistudio-webui";

function requestedBuiltinTools(body: Record<string, unknown>): BuiltinToolName[] {
  if (!Array.isArray(body.tools)) return [];
  const names = new Set<BuiltinToolName>();
  for (const item of body.tools) {
    if (!isRecord(item)) continue;
    if (typeof item.type === "string" && (BUILTIN_TOOL_NAMES as readonly string[]).includes(item.type)) {
      names.add(item.type as BuiltinToolName);
    }
    if (item.googleSearch !== undefined || item.googleSearchRetrieval !== undefined) names.add("google_search");
    if (item.codeExecution !== undefined) names.add("code_execution");
    if (item.googleMaps !== undefined) names.add("google_maps");
    if (item.urlContext !== undefined) names.add("url_context");
  }
  return [...names];
}

function isWebUiRequest(request: { readonly headers: Record<string, unknown> }): boolean {
  const value = request.headers[WEB_UI_HEADER];
  return value === "1" || value === "true";
}

function rejectUnsupportedKeyPermissions(body: Record<string, unknown>): void {
  if (body.permissions !== undefined) {
    throw new HttpError(422, "API 密钥不再支持内置工具权限；内置原生工具仅限 WebUI 使用");
  }
}

function stripBuiltinToolsForApi(webUi: boolean, body: Record<string, unknown>): Record<string, unknown> {
  if (webUi || requestedBuiltinTools(body).length === 0 || !Array.isArray(body.tools)) return body;
  // External API calls keep local function declarations but never send the
  // AI Studio-native tools. This lets existing mixed-tool callers continue
  // their local function rounds without exposing WebUI-only capabilities.
  return {
    ...body,
    tools: body.tools.filter((item) => !requestedBuiltinTools({ tools: [item] }).length),
  };
}

function bodyRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new HttpError(422, "请求体必须是 JSON 对象");
  return value;
}

function modelCard(id: string): Record<string, unknown> {
  const methods = id.includes("tts")
      ? ["generateContent"]
      : ["generateContent", "streamGenerateContent"];
  return { name: `models/${id}`, displayName: id, supportedGenerationMethods: methods };
}

function requestToken(request: { headers: Record<string, unknown>; query: unknown }): string | undefined {
  for (const name of ["x-api-key", "x-goog-api-key"] as const) {
    const value = request.headers[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  if (isRecord(request.query) && typeof request.query.key === "string" && request.query.key.trim()) {
    return request.query.key.trim();
  }
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") return undefined;
  const match = /^Bearer\s+(.+)$/iu.exec(authorization.trim());
  return match?.[1]?.trim() || undefined;
}

function isPublicRoute(method: string, url: string): boolean {
  const path = url.split("?", 1)[0] ?? url;
  return method === "GET" && (path === "/" || path === "/login" || path === "/health" || path === "/auth/check" || path.startsWith("/static/"));
}

async function sendStream(
  reply: FastifyReply,
  operation: (onChunk: (chunk: string) => void, signal: AbortSignal) => Promise<unknown>,
  options: { readonly doneMarker?: boolean } = {},
): Promise<void> {
  const controller = new AbortController();
  const onClose = (): void => {
    if (!reply.raw.writableEnded) controller.abort();
  };
  reply.raw.once("close", onClose);
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    "x-accel-buffering": "no",
    connection: "keep-alive",
  });
  try {
    await operation((chunk) => {
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.write(chunk);
    }, controller.signal);
  } catch (error) {
    if (!reply.raw.destroyed && !reply.raw.writableEnded && (error as Error).name !== "AbortError") {
      const detail = error instanceof BridgeError ? error.detail : errorDetail(String(error), "server_error");
      // The Gemini wire route must not emit event lines or [DONE] (its clients
      // parse every data line as JSON); the Interactions route opts in.
      const prefix = options.doneMarker ? "event: error\n" : "";
      reply.raw.write(`${prefix}data: ${JSON.stringify({ error: detail })}\n\n`);
      if (options.doneMarker) reply.raw.write("event: done\ndata: [DONE]\n\n");
    }
  } finally {
    reply.raw.off("close", onClose);
    if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
  }
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const bridge = options.services?.bridge ?? new NativeBackendBridge();
  const apiKeys = options.services?.apiKeys ?? new ApiKeyStore();
  const interactions = options.services?.interactions ?? new InteractionStore();
  const requestContext = new WeakMap<object, { readonly webUi: boolean }>();
  const app = Fastify({ logger: options.logger ?? true, bodyLimit: settings.bodyLimitBytes });
  const runtimeConfig = new RuntimeConfigStore(options.runtimeConfigFile);

  app.decorate("backendServices", { bridge, apiKeys, interactions });

  app.setErrorHandler((error, _request, reply) => {
    if ((error as { code?: unknown }).code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      reply.status(413).send({
        detail: errorDetail(`Request body is too large; limit is ${settings.bodyLimitBytes} bytes`, "request_too_large"),
      });
      return;
    }
    if (error instanceof HttpError || error instanceof BridgeError) {
      const status = error instanceof HttpError ? error.statusCode : error.statusCode;
      if (error instanceof HttpError && error.headers) {
        for (const [name, value] of Object.entries(error.headers)) reply.header(name, value);
      }
      reply.status(status).send({ detail: error.detail });
      return;
    }
    const fallback = error as { statusCode?: unknown; message?: unknown };
    const status = typeof fallback.statusCode === "number" ? fallback.statusCode : 500;
    app.log.error(error as Error);
    reply.status(status).send({ detail: errorDetail(String(fallback.message ?? error), "server_error") });
  });

  app.setNotFoundHandler((_request, reply) => {
    reply.status(404).send({ detail: errorDetail("Not Found", "not_found") });
  });

  app.addHook("onRequest", async (request) => {
    if (isPublicRoute(request.method, request.url)) return;
    const authEnabled = settings.configuredApiKeys.size > 0 || await apiKeys.hasKeys();
    if (!authEnabled) {
      requestContext.set(request, { webUi: isWebUiRequest(request) });
      return;
    }
    const token = requestToken({ headers: request.headers, query: request.query });
    if (token && settings.configuredApiKeys.has(token)) {
      requestContext.set(request, { webUi: isWebUiRequest(request) });
      return;
    }
    const authenticated = token ? await apiKeys.authenticate(token) : undefined;
    if (authenticated) {
      requestContext.set(request, { webUi: isWebUiRequest(request) });
      return;
    }
    throw new HttpError(
      401,
      errorDetail("Invalid or missing API key", "authentication_error"),
      { "www-authenticate": "Bearer" },
    );
  });

  if ((options.serveStatic ?? true) && existsSync(settings.staticDir)) {
    await app.register(fastifyStatic, { root: settings.staticDir, prefix: "/static/" });
  }

  app.get("/", async (_request, reply) => reply.redirect("/static/index.html"));
  app.get("/login", async (_request, reply) => reply.redirect("/static/login.html"));
  app.get("/auth/check", async () => ({
    auth_enabled: settings.configuredApiKeys.size > 0 || await apiKeys.hasKeys(),
    capabilities: {
      gateway: "native",
      automatic_login: process.platform === "win32" || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY),
      remote_login: true,
      cookie_import: true,
      streaming: "incremental",
    },
  }));
  app.get("/auth/verify", async () => ({ ok: true }));

  app.get("/health", async () => bridge.request("health"));
  app.get("/stats", async () => bridge.request("stats"));
  app.get("/system/status", async () => ({
    server: "fastify",
    pid: process.pid,
    uptime_seconds: Math.floor(process.uptime()),
    port: settings.port,
    body_limit_bytes: settings.bodyLimitBytes,
    bridge: bridge.status(),
  }));

  app.get("/config/runtime", async () => runtimeConfig.read());
  app.put("/config/runtime", async (request) => {
    try {
      const view = await runtimeConfig.save(bodyRecord(request.body));
      return { ok: true, ...view };
    } catch (error) {
      if (error instanceof TypeError || error instanceof RangeError) throw new HttpError(422, error.message);
      throw error;
    }
  });

  app.get("/config/model-defaults", async () => {
    try {
      const payload = parse(await readFile(settings.modelDefaultsFile, "utf8")) as unknown;
      return isRecord(payload) && isRecord(payload.model_defaults) ? payload.model_defaults : { profiles: [], models: {} };
    } catch {
      return { profiles: [], models: {} };
    }
  });
  app.post("/config/model-defaults", async (request) => {
    const body = bodyRecord(request.body);
    if (!Array.isArray(body.profiles) || !isRecord(body.models)) {
      throw new HttpError(422, "profiles 必须是数组，models 必须是对象");
    }
    await writeFile(settings.modelDefaultsFile, stringify({ model_defaults: body }), "utf8");
    await bridge.request("reload_model_defaults");
    return { ok: true };
  });

  app.get("/rotation", async () => bridge.request("rotation_status"));
  app.get("/rotation/accounts", async () => bridge.request("rotation_accounts"));
  app.post("/rotation/mode", async (request) => {
    const body = bodyRecord(request.body);
    if (typeof body.mode !== "string") throw new HttpError(422, "mode 必须是字符串");
    return bridge.request("rotation_mode", {
      mode: body.mode,
      ...(body.cooldown_seconds !== undefined ? { cooldown_seconds: body.cooldown_seconds } : {}),
    });
  });
  app.post("/rotation/next", async () => bridge.request("rotation_next"));

  app.get("/api-keys", async () => apiKeys.list());
  app.post("/api-keys", async (request, reply) => {
    const body = bodyRecord(request.body);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) throw new HttpError(422, "密钥名称不能为空");
    if (name.length > 100) throw new HttpError(422, "密钥名称不能超过 100 个字符");
    rejectUnsupportedKeyPermissions(body);
    reply.status(201);
    return apiKeys.create(name);
  });
  app.put<{ Params: { keyId: string } }>("/api-keys/:keyId", async (request) => {
    const body = bodyRecord(request.body);
    rejectUnsupportedKeyPermissions(body);
    if (typeof body.name !== "string" || !body.name.trim()) throw new HttpError(422, "name 必须是非空字符串");
    const name = body.name.trim();
    if (name.length > 100) throw new HttpError(422, "密钥名称不能超过 100 个字符");
    const updated = await apiKeys.update(request.params.keyId, { name });
    if (!updated) throw new HttpError(404, "API 密钥不存在");
    return updated;
  });
  app.delete<{ Params: { keyId: string } }>("/api-keys/:keyId", async (request, reply) => {
    if (!await apiKeys.delete(request.params.keyId)) throw new HttpError(404, "API 密钥不存在");
    reply.status(204).send();
  });

  app.get("/accounts", async () => bridge.request("accounts_list"));
  app.get("/accounts/active", async () => bridge.request("accounts_active"));
  app.post("/accounts/login/start", async (request) => {
    const body = bodyRecord(request.body);
    if (body.remote === true && settings.configuredApiKeys.size === 0 && !await apiKeys.hasKeys()) {
      throw new HttpError(403, errorDetail("远程登录要求先配置 API 密钥，避免 Google 凭据暴露在未鉴权接口", "authentication_required"));
    }
    return bridge.request("login_start", {
      ...(typeof body.name === "string" ? { name: body.name } : {}),
      remote: body.remote === true,
    });
  });
  app.get<{ Params: { sessionId: string } }>("/accounts/login/status/:sessionId", async (request) => (
    bridge.request("login_status", { session_id: request.params.sessionId })
  ));
  app.post("/accounts/login/input", async (request) => {
    const body = bodyRecord(request.body);
    if (typeof body.session_id !== "string" || typeof body.value !== "string") {
      throw new HttpError(422, "session_id 和 value 必须是字符串");
    }
    return bridge.request("login_input", { session_id: body.session_id, value: body.value });
  });
  app.delete<{ Params: { sessionId: string } }>("/accounts/login/:sessionId", async (request) => (
    bridge.request("login_cancel", { session_id: request.params.sessionId })
  ));
  app.post<{ Params: { accountId: string } }>("/accounts/:accountId/refresh", async (request) => (
    bridge.request("accounts_refresh", { account_id: request.params.accountId })
  ));
  app.post<{ Params: { accountId: string } }>("/accounts/:accountId/activate", async (request) => (
    bridge.request("accounts_activate", { account_id: request.params.accountId })
  ));
  app.put<{ Params: { accountId: string } }>("/accounts/:accountId", async (request) => {
    const body = bodyRecord(request.body);
    if (typeof body.name !== "string") throw new HttpError(422, "name 必须是字符串");
    return bridge.request("accounts_update", { account_id: request.params.accountId, name: body.name });
  });
  app.delete<{ Params: { accountId: string } }>("/accounts/:accountId", async (request) => (
    bridge.request("accounts_delete", { account_id: request.params.accountId })
  ));
  app.post("/accounts/import-cookies", async (request) => bridge.request("import_cookies", bodyRecord(request.body)));

  for (const version of ["v1", "v1beta", "v1beta2"] as const) {
    app.post(`/${version}/interactions`, async (request, reply) => {
      const body = stripBuiltinToolsForApi(requestContext.get(request)?.webUi === true, bodyRecord(request.body));
      if (body.stream === true) {
        // Validate before hijacking so 400/404 keep their real status codes.
        await bridge.request("interaction_validate", { body });
        await sendStream(reply, (onChunk, signal) => bridge.request("interaction_create", { body }, onChunk, signal), { doneMarker: true });
        return;
      }
      return bridge.request("interaction_create", { body });
    });
    app.get(`/${version}/interactions`, async (request) => {
      const query = isRecord(request.query) ? request.query : {};
      const rawLimit = query.limit;
      const limit = typeof rawLimit === "string" ? Number.parseInt(rawLimit, 10) : undefined;
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) throw new HttpError(422, "limit 必须是非负整数");
      const records = await interactions.list();
      const selected = limit === undefined ? records : records.slice(0, limit);
      return { object: "list", interactions: selected.map((record) => record.interaction ?? {}) };
    });
    app.get<{ Params: { interactionId: string } }>(`/${version}/interactions/:interactionId`, async (request) => {
      const record = await interactions.get(request.params.interactionId);
      if (!record) throw new HttpError(404, errorDetail(`Interaction not found: ${request.params.interactionId}`, "not_found"));
      return record.interaction ?? {};
    });
    app.delete<{ Params: { interactionId: string } }>(`/${version}/interactions/:interactionId`, async (request, reply) => {
      if (!await interactions.delete(request.params.interactionId)) {
        throw new HttpError(404, errorDetail(`Interaction not found: ${request.params.interactionId}`, "not_found"));
      }
      reply.status(200).send();
    });
    app.post<{ Params: { interactionId: string } }>(`/${version}/interactions/:interactionId/cancel`, async () => {
      throw new HttpError(400, errorDetail("cancel is only available for background interactions, which are not supported", "bad_request"));
    });
  }

  async function availableModels(): Promise<{
    readonly models: Record<string, unknown>[];
    readonly source: "live" | "fallback";
  }> {
    try {
      const models = await bridge.request<unknown>("models");
      if (Array.isArray(models)) {
        const validModels = models.filter(isRecord);
        if (validModels.length > 0) return { models: validModels, source: "live" };
      }
    } catch (error) {
      app.log.warn({ err: error }, "读取 AI Studio 模型目录失败，使用内置目录");
    }
    return { models: FALLBACK_MODELS.map(modelCard), source: "fallback" };
  }

  app.get("/v1beta/models", async () => availableModels());
  app.get<{ Params: { "*": string } }>("/v1beta/models/*", async (request) => {
    const id = request.params["*"].replace(/^models\//u, "");
    const name = `models/${id}`;
    const model = (await availableModels()).models.find((item) => item.name === name);
    if (!model) throw new HttpError(404, errorDetail(`Model '${id}' not found`, "not_found"));
    return model;
  });
  app.post<{ Params: { "*": string } }>("/v1beta/*", async (request, reply) => {
    const target = request.params["*"];
    const match = /^(.*):(generateContent|streamGenerateContent)$/u.exec(target);
    if (!match?.[1] || !match[2]) throw new HttpError(404, errorDetail("Not Found", "not_found"));
    const model = match[1];
    const action = match[2];
    const body = stripBuiltinToolsForApi(requestContext.get(request)?.webUi === true, bodyRecord(request.body));
    if (action === "streamGenerateContent") {
      await sendStream(reply, (onChunk, signal) => bridge.request("generate", { model, body, stream: true }, onChunk, signal));
      return;
    }
    return bridge.request("generate", { model, body, stream: false });
  });

  app.addHook("onClose", async () => bridge.stop());
  await bridge.start();
  return app;
}

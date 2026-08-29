// ---------- 原生 Gemini generateContent 聊天 ----------
import { ref } from "vue";
import { useClipboard } from "@vueuse/core";
import { apiFetch, toastOk, toastErr } from "../api/client";
import { cfg, model, msgs } from "./useCache";
import type {
  Attachment,
  AttachmentKind,
  BuiltinToolName,
  Message,
  NativeContent,
  NativeGenerateRequest,
  NativePart,
  ToolCall,
} from "../types";

interface NativeResponse {
  candidates?: Array<{
    content?: { parts?: NativePart[] };
  }>;
  error?: unknown;
}

const draft = ref("");
const selectedAttachments = ref<Attachment[]>([]);
const busy = ref(false);
const abortCtrl = ref<AbortController | null>(null);
const copiedIdx = ref(-1);
/** 自增触发器：Composer 监听它聚焦输入框（useSuggestion 场景） */
const focusTick = ref(0);

const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
// Keep the base64 JSON request below the default 32 MiB Fastify body limit.
const MAX_TOTAL_ATTACHMENT_BYTES = 16 * 1024 * 1024;
const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  flac: "audio/flac",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  pdf: "application/pdf",
  json: "application/json",
  xml: "application/xml",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  ts: "text/typescript",
  py: "text/x-python",
  java: "text/x-java",
  go: "text/x-go",
  rs: "text/x-rust",
  yaml: "text/yaml",
  yml: "text/yaml",
  log: "text/plain",
};

function fileMimeType(file: File): string {
  const extension = file.name.split(".").pop()?.toLowerCase() || "";
  return (
    file.type || MIME_BY_EXTENSION[extension] || "application/octet-stream"
  );
}

function attachmentKind(file: File): AttachmentKind | null {
  const mime = fileMimeType(file);
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (
    file.type === "application/pdf" ||
    file.type === "application/json" ||
    file.type === "application/xml" ||
    file.type === "text/xml" ||
    file.type.startsWith("text/") ||
    /\.(?:pdf|txt|md|csv|json|xml|html?|css|js|ts|py|java|go|rs|yaml|yml|log)$/iu.test(
      file.name,
    )
  )
    return "document";
  return null;
}

function attachmentToPart(attachment: Attachment): NativePart | null {
  const match = /^data:([^;]+);base64,([\s\S]+)$/u.exec(attachment.data_url);
  if (!match) return null;
  return {
    inlineData: {
      mimeType: match[1] ?? attachment.mime_type,
      data: match[2] ?? "",
    },
  };
}

const suggestions = [
  "帮我写一首关于春天的短诗",
  "解释一下量子纠缠",
  "用表格对比 Gemini 3 和 Gemma 4",
  "画一只在月球上的猫",
];

function messageToNativeContent(message: Message): NativeContent | null {
  const parts: NativePart[] = [];
  if (message.role === "user") {
    if (message.content) parts.push({ text: message.content });
    (message.attachments || []).forEach((attachment) => {
      const part = attachmentToPart(attachment);
      if (part) parts.push(part);
    });
    // Keep conversations created before the attachment model backward-compatible.
    if (!message.attachments?.length) {
      (message.images || []).forEach((data) => {
        const match = /^data:([^;]+);base64,([\s\S]+)$/u.exec(data || "");
        if (match)
          parts.push({
            inlineData: {
              mimeType: match[1] ?? "image/png",
              data: match[2] ?? "",
            },
          });
      });
    }
  } else {
    // Gemini 3 stateless requests require thought parts to retain their
    // original signatures. Never replay an old unsigned thought summary as a
    // synthetic thought block; doing so can invalidate the whole request.
    if (message.thinking && message.thinkingSignature) {
      parts.push({
        text: message.thinking,
        thought: true,
        thoughtSignature: message.thinkingSignature,
      });
    }
    (message.toolCalls || []).forEach((call) => {
      if (!call.name) return;
      parts.push({
        functionCall: {
          name: call.name,
          args: call.arguments ?? {},
          ...(call.id ? { id: call.id } : {}),
        },
        ...(call.signature ? { thoughtSignature: call.signature } : {}),
      });
    });
    if (message.content) parts.push({ text: message.content });
  }
  return parts.length > 0
    ? { role: message.role === "user" ? "user" : "model", parts }
    : null;
}

function buildNativeContents(): NativeContent[] {
  return msgs.value
    .map(messageToNativeContent)
    .filter((content): content is NativeContent => Boolean(content));
}

function buildNativeRequest(): NativeGenerateRequest {
  const body: NativeGenerateRequest = { contents: buildNativeContents() };
  const generationConfig: Record<string, unknown> = {};
  if (cfg.value.temperature !== 1)
    generationConfig.temperature = cfg.value.temperature;
  if (cfg.value.topP !== 0.95) generationConfig.topP = cfg.value.topP;
  if (cfg.value.maxTokens !== 32768)
    generationConfig.maxOutputTokens = cfg.value.maxTokens;
  if (cfg.value.thinking !== "off") {
    generationConfig.thinkingConfig = { thinkingLevel: cfg.value.thinking };
  }
  if (Object.keys(generationConfig).length > 0)
    body.generationConfig = generationConfig;

  const toolNames: BuiltinToolName[] = [];
  const normalizedModel = model.value.replace(/^models\//u, "").toLowerCase();
  const isTts = normalizedModel.includes("tts");
  const isImage = normalizedModel.includes("image");
  if (cfg.value.search === "on" && !isTts) toolNames.push("google_search");
  if (cfg.value.codeExecution === "on" && !isTts && !isImage)
    toolNames.push("code_execution");
  if (
    cfg.value.googleMaps === "on" &&
    normalizedModel.startsWith("gemini-") &&
    !isTts &&
    !isImage
  )
    toolNames.push("google_maps");
  if (
    cfg.value.urlContext === "on" &&
    normalizedModel.startsWith("gemini-") &&
    !isTts &&
    !isImage
  )
    toolNames.push("url_context");
  body.tools = toolNames.map((type) => ({ type }));

  if (cfg.value.safety === "off") {
    body.safetySettings = [
      "HARM_CATEGORY_HARASSMENT",
      "HARM_CATEGORY_HATE_SPEECH",
      "HARM_CATEGORY_SEXUALLY_EXPLICIT",
      "HARM_CATEGORY_DANGEROUS_CONTENT",
    ].map((category) => ({ category, threshold: "OFF" }));
  }
  return body;
}

function responseParts(response: NativeResponse): NativePart[] {
  const candidate = response.candidates?.[0];
  return candidate?.content?.parts || [];
}

function appendToolCall(message: Message, call: ToolCall): void {
  if (!call.name) return;
  const key = `${call.id || call.name}:${JSON.stringify(call.arguments ?? {})}`;
  const exists = (message.toolCalls || []).some(
    (item) =>
      `${item.id || item.name}:${JSON.stringify(item.arguments ?? {})}` === key,
  );
  if (!exists) message.toolCalls = [...(message.toolCalls || []), call];
}

function appendNativeResponse(
  message: Message,
  response: NativeResponse,
): void {
  for (const part of responseParts(response)) {
    if (typeof part.text === "string") {
      if (part.thought === true)
        message.thinking = (message.thinking || "") + part.text;
      else message.content += part.text;
    }
    if (part.thoughtSignature && part.thought === true)
      message.thinkingSignature = part.thoughtSignature;
    if (part.functionCall?.name) {
      appendToolCall(message, {
        name: part.functionCall.name,
        arguments: part.functionCall.args ?? {},
        ...(part.functionCall.id ? { id: part.functionCall.id } : {}),
        ...(part.thoughtSignature ? { signature: part.thoughtSignature } : {}),
      });
    }
    if (part.inlineData?.data) {
      const mime = part.inlineData.mimeType || "application/octet-stream";
      if (mime.startsWith("image/"))
        message.content += `![image](data:${mime};base64,${part.inlineData.data})\n`;
      else if (mime.startsWith("audio/"))
        message.content += `[音频](data:${mime};base64,${part.inlineData.data})\n`;
    }
  }
}

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "message" in value)
    return String((value as { message?: unknown }).message);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function readNativeStream(
  response: Response,
  message: Message,
  onProgress: () => void,
): Promise<void> {
  if (!response.body) throw new Error("响应没有可读取的流");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const consumeLine = (line: string): void => {
    if (!line.startsWith("data:")) return;
    const raw = line.slice(5).trim();
    if (!raw) return;
    let data: NativeResponse;
    try {
      data = JSON.parse(raw) as NativeResponse;
    } catch {
      throw new Error("收到无效的原生 SSE 数据");
    }
    if (data.error !== undefined) throw new Error(errorText(data.error));
    appendNativeResponse(message, data);
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    lines.forEach(consumeLine);
    onProgress();
  }
  buffer += decoder.decode();
  if (buffer) consumeLine(buffer);
}

export function useChat() {
  /** 用户是否停留在底部附近（流式期间据此决定是否跟随滚动） */
  function isNearBottom(el: HTMLElement, threshold = 120): boolean {
    return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  }

  function scrollDown(force = false): void {
    setTimeout(() => {
      const el = document.getElementById("chat-scroll");
      if (!el) return;
      if (force || isNearBottom(el)) el.scrollTop = el.scrollHeight;
    }, 50);
  }

  function newChat(): void {
    msgs.value = [];
    selectedAttachments.value = [];
    toastOk("已创建新对话");
  }

  function addFiles(files: Iterable<File>): void {
    let total = selectedAttachments.value.reduce(
      (sum, item) => sum + (item.size || 0),
      0,
    );
    for (const file of files) {
      const kind = attachmentKind(file);
      if (!kind) {
        toastErr(`暂不支持读取此文件：${file.name}`);
        continue;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        toastErr(`文件过大：${file.name}，单文件上限 15 MB`);
        continue;
      }
      if (total + file.size > MAX_TOTAL_ATTACHMENT_BYTES) {
        toastErr("附件总大小不能超过 16 MB");
        break;
      }
      total += file.size;
      const reader = new FileReader();
      reader.onload = (event) => {
        const dataUrl = (event.target as FileReader).result;
        if (typeof dataUrl !== "string") return;
        selectedAttachments.value.push({
          name: file.name,
          mime_type: fileMimeType(file),
          data_url: dataUrl,
          kind,
          size: file.size,
        });
      };
      reader.onerror = () => toastErr(`读取文件失败：${file.name}`);
      reader.readAsDataURL(file);
    }
  }

  function handleFileUpload(event: Event): void {
    const input = event.target as HTMLInputElement;
    addFiles(Array.from(input.files || []));
    input.value = "";
  }

  function removeAttachment(index: number): void {
    selectedAttachments.value.splice(index, 1);
  }

  async function send(): Promise<void> {
    const text = draft.value.trim();
    const attachments = [...selectedAttachments.value];
    if (!text && !attachments.length) return;
    if (busy.value || !model.value) return;

    msgs.value.push({ role: "user", content: text, attachments });
    draft.value = "";
    selectedAttachments.value = [];
    busy.value = true;
    scrollDown(true);

    try {
      abortCtrl.value = new AbortController();
      const stream = cfg.value.stream === "on";
      const action = stream ? "streamGenerateContent" : "generateContent";
      const url = `/v1beta/models/${encodeURIComponent(model.value.replace(/^models\//u, ""))}:${action}`;
      const response = await apiFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildNativeRequest()),
        signal: abortCtrl.value.signal,
      });
      if (response.ok) {
        const assistant: Message = {
          role: "assistant",
          content: "",
          thinking: "",
          showThinking: false,
        };
        msgs.value.push(assistant);
        if (stream) {
          await readNativeStream(response, assistant, scrollDown);
        } else {
          appendNativeResponse(
            assistant,
            (await response.json()) as NativeResponse,
          );
        }
        if (
          !assistant.content &&
          !assistant.thinking &&
          !(assistant.toolCalls && assistant.toolCalls.length)
        ) {
          assistant.content = "(无响应内容)";
        }
      } else {
        let detail = response.statusText;
        try {
          const payload = (await response.json()) as {
            detail?: unknown;
            error?: unknown;
          };
          if (payload.detail !== undefined) detail = errorText(payload.detail);
          else if (payload.error !== undefined)
            detail = errorText(payload.error);
        } catch {
          /* 保持 statusText */
        }
        msgs.value.push({
          role: "assistant",
          content: "",
          error: `Error ${response.status}: ${detail}`,
        });
      }
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        const last = msgs.value[msgs.value.length - 1];
        if (last && last.role === "assistant") last.error = "已停止生成";
        else
          msgs.value.push({
            role: "assistant",
            content: "",
            error: "已停止生成",
          });
      } else {
        const last = msgs.value[msgs.value.length - 1];
        if (
          last &&
          last.role === "assistant" &&
          !last.content &&
          !last.thinking
        )
          last.error = (error as Error).message;
        else
          msgs.value.push({
            role: "assistant",
            content: "",
            error: (error as Error).message,
          });
      }
    } finally {
      busy.value = false;
      abortCtrl.value = null;
      scrollDown();
    }
  }

  function stopGeneration(): void {
    abortCtrl.value?.abort();
  }

  async function copyMessage(index: number): Promise<void> {
    const message = msgs.value[index];
    if (!message) return;
    const text =
      (message.content || "") +
      (message.thinking ? "\n\n[思考过程]\n" + message.thinking : "");
    const { copy } = useClipboard({ legacy: true });
    await copy(text);
    copiedIdx.value = index;
    setTimeout(() => {
      if (copiedIdx.value === index) copiedIdx.value = -1;
    }, 1500);
  }

  function regenerate(): void {
    if (busy.value) return;
    while (
      msgs.value.length &&
      msgs.value[msgs.value.length - 1]?.role === "assistant"
    )
      msgs.value.pop();
    const lastUser = msgs.value[msgs.value.length - 1];
    if (!lastUser || lastUser.role !== "user") {
      toastErr("没有可重新生成的对话");
      return;
    }
    msgs.value.pop();
    draft.value = lastUser.content || "";
    selectedAttachments.value = lastUser.attachments
      ? [...lastUser.attachments]
      : (lastUser.images || []).map((dataUrl, index) => ({
          name: `image-${index + 1}`,
          mime_type: dataUrl.match(/^data:([^;]+)/u)?.[1] || "image/png",
          data_url: dataUrl,
          kind: "image" as const,
        }));
    void send();
  }

  function useSuggestion(text: string): void {
    draft.value = text;
    focusTick.value++;
  }

  return {
    draft,
    selectedAttachments,
    busy,
    copiedIdx,
    focusTick,
    suggestions,
    msgs,
    scrollDown,
    isNearBottom,
    newChat,
    addFiles,
    handleFileUpload,
    removeAttachment,
    send,
    stopGeneration,
    copyMessage,
    regenerate,
    useSuggestion,
  };
}

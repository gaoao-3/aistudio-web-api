// ---------- 聊天（从 app.ts 的输入/发送/流式/消息操作方法移植） ----------
import { ref } from 'vue';
import { useClipboard } from '@vueuse/core';
import { apiFetch, toastOk, toastErr } from '../api/client';
import { cfg, model, msgs } from './useCache';
import type { Attachment, AttachmentKind, BuiltinToolName, InteractionRequest, InteractionStep, StepContent, ToolCall } from '../types';

interface StreamEvent {
  event_type?: string;
  index?: number;
  delta?: {
    type?: string;
    text?: string;
    data?: string;
    mime_type?: string;
  };
  step?: InteractionStep;
  error?: { message?: string };
}

const draft = ref('');
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
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
  pdf: 'application/pdf', json: 'application/json', xml: 'application/xml', txt: 'text/plain', md: 'text/markdown',
  csv: 'text/csv', html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', ts: 'text/typescript',
  py: 'text/x-python', java: 'text/x-java', go: 'text/x-go', rs: 'text/x-rust', yaml: 'text/yaml', yml: 'text/yaml', log: 'text/plain',
};

function fileMimeType(file: File): string {
  const extension = file.name.split('.').pop()?.toLowerCase() || '';
  return file.type || MIME_BY_EXTENSION[extension] || 'application/octet-stream';
}

function attachmentKind(file: File): AttachmentKind | null {
  const mime = fileMimeType(file);
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (
    file.type === 'application/pdf'
    || file.type === 'application/json'
    || file.type === 'application/xml'
    || file.type === 'text/xml'
    || file.type.startsWith('text/')
    || /\.(?:pdf|txt|md|csv|json|xml|html?|css|js|ts|py|java|go|rs|yaml|yml|log)$/iu.test(file.name)
  ) return 'document';
  return null;
}

function attachmentDataUrl(attachment: Attachment): StepContent | null {
  const match = /^data:([^;]+);base64,([\s\S]+)$/u.exec(attachment.data_url);
  if (!match) return null;
  const type = attachment.kind === 'image'
    ? 'image'
    : attachment.kind === 'audio'
      ? 'audio'
      : 'document';
  return { type, mime_type: match[1], data: match[2] };
}

const suggestions = [
  '帮我写一首关于春天的短诗',
  '解释一下量子纠缠',
  '用表格对比 Gemini 3 和 Gemma 4',
  '画一只在月球上的猫',
];

export function useChat() {
  /** 用户是否停留在底部附近（流式期间据此决定是否跟随滚动） */
  function isNearBottom(el: HTMLElement, threshold = 120): boolean {
    return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  }

  function scrollDown(force = false): void {
    setTimeout(() => {
      const el = document.getElementById('chat-scroll');
      if (!el) return;
      if (force || isNearBottom(el)) el.scrollTop = el.scrollHeight;
    }, 50);
  }

  function newChat(): void {
    msgs.value = [];
    selectedAttachments.value = [];
    toastOk('已创建新对话');
  }

  function addFiles(files: Iterable<File>): void {
    let total = selectedAttachments.value.reduce((sum, item) => sum + (item.size || 0), 0);
    for (const f of files) {
      const kind = attachmentKind(f);
      if (!kind) {
        toastErr(`暂不支持读取此文件：${f.name}`);
        continue;
      }
      if (f.size > MAX_ATTACHMENT_BYTES) {
        toastErr(`文件过大：${f.name}，单文件上限 15 MB`);
        continue;
      }
      if (total + f.size > MAX_TOTAL_ATTACHMENT_BYTES) {
        toastErr('附件总大小不能超过 16 MB');
        break;
      }
      total += f.size;
      const reader = new FileReader();
      reader.onload = ev => {
        const dataUrl = (ev.target as FileReader).result;
        if (typeof dataUrl !== 'string') return;
        selectedAttachments.value.push({
          name: f.name,
          mime_type: fileMimeType(f),
          data_url: dataUrl,
          kind,
          size: f.size,
        });
      };
      reader.onerror = () => toastErr(`读取文件失败：${f.name}`);
      reader.readAsDataURL(f);
    }
  }

  function handleFileUpload(e: Event): void {
    const input = e.target as HTMLInputElement;
    addFiles(Array.from(input.files || []));
    input.value = '';
  }

  function removeAttachment(idx: number): void {
    selectedAttachments.value.splice(idx, 1);
  }

  function buildInteractionSteps(): InteractionStep[] {
    const steps: InteractionStep[] = [];
    for (const m of msgs.value) {
      if (m.role === 'user') {
        const content: StepContent[] = [];
        if (m.content) content.push({ type: 'text', text: m.content });
        (m.attachments || []).forEach(attachment => {
          const item = attachmentDataUrl(attachment);
          if (item) content.push(item);
        });
        // Keep conversations created before the attachment model backward-compatible.
        if (!m.attachments?.length) {
          (m.images || []).forEach(img => {
            const match = /^data:([^;]+);base64,([\s\S]+)$/u.exec(img || '');
            if (match) content.push({ type: 'image', mime_type: match[1], data: match[2] });
          });
        }
        if (content.length) steps.push({ type: 'user_input', content });
        continue;
      }
      if (m.content) steps.push({ type: 'model_output', content: [{ type: 'text', text: m.content }] });
      (m.toolCalls || []).forEach(tc => steps.push({
        type: 'function_call', id: tc.id, name: tc.name, arguments: tc.arguments,
        ...(tc.signature ? { signature: tc.signature } : {}),
      }));
    }
    return steps;
  }

  async function send(): Promise<void> {
    const t = draft.value.trim();
    const attachments = [...selectedAttachments.value];
    if (!t && !attachments.length) return;
    if (busy.value || !model.value) return;
    msgs.value.push({ role: 'user', content: t, attachments });
    draft.value = '';
    selectedAttachments.value = [];
    busy.value = true;
    scrollDown(true);

    const body: InteractionRequest = { model: model.value, input: buildInteractionSteps(), store: false };
    const gc: Record<string, unknown> = {};
    if (cfg.value.temperature !== 1) gc.temperature = cfg.value.temperature;
    if (cfg.value.topP !== 1) gc.top_p = cfg.value.topP;
    if (cfg.value.maxTokens !== 8192) gc.max_output_tokens = cfg.value.maxTokens;
    if (cfg.value.thinking !== 'off') gc.thinking_level = cfg.value.thinking;
    if (Object.keys(gc).length) body.generation_config = gc;
    if (cfg.value.stream === 'on') body.stream = true;
    // Always send the tool list so turning all tools off is explicit. AI Studio
    // only exposes the general built-ins on non-image, non-TTS text models.
    const toolNames: BuiltinToolName[] = [];
    const normalizedModel = model.value.replace(/^models\//u, '').toLowerCase();
    const isTts = normalizedModel.includes('tts');
    const isImage = normalizedModel.includes('image');
    if (cfg.value.search === 'on' && !isTts) toolNames.push('google_search');
    if (cfg.value.codeExecution === 'on' && !isTts && !isImage) toolNames.push('code_execution');
    if (cfg.value.googleMaps === 'on' && normalizedModel.startsWith('gemini-') && !isTts && !isImage) toolNames.push('google_maps');
    if (cfg.value.urlContext === 'on' && normalizedModel.startsWith('gemini-') && !isTts && !isImage) toolNames.push('url_context');
    body.tools = toolNames.map(type => ({ type }));
    if (cfg.value.safety === 'off') {
      body.safety_settings = ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT']
        .map(category => ({ category, threshold: 'OFF' }));
    }

    try {
      abortCtrl.value = new AbortController();
      const r = await apiFetch('/v1beta/interactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: abortCtrl.value.signal,
      });
      if (!r.ok) {
        let e = r.statusText;
        try {
          const d = await r.json() as { detail?: unknown };
          if (d.detail) e = JSON.stringify(d.detail);
        } catch (x) { /* 保持 statusText */ }
        msgs.value.push({ role: 'assistant', content: '', error: `Error ${r.status}: ${e}` });
      } else if (cfg.value.stream === 'on') {
        const reader = r.body!.getReader();
        const dec = new TextDecoder();
        msgs.value.push({ role: 'assistant', content: '', thinking: '', showThinking: false });
        const idx = msgs.value.length - 1;
        let buf = '';
        // 新版 steps schema 下 thought 与 model_output 的文本 delta 形状相同，
        // 只能靠 step.start 声明的 index → 类型来区分。
        const stepTypes = new Map<number, string>();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() || '';
          for (const ln of lines) {
            if (ln.startsWith('data: ')) {
              try {
                const d = JSON.parse(ln.slice(6)) as StreamEvent;
                if (d.event_type === 'step.delta') {
                  const delta = d.delta || {};
                  const isThought = stepTypes.get(d.index ?? -1) === 'thought';
                  if (delta.type === 'text' && delta.text) {
                    if (isThought) msgs.value[idx].thinking! += delta.text;
                    else msgs.value[idx].content += delta.text;
                  } else if (delta.type === 'image' && delta.data) msgs.value[idx].content += `![image](data:${delta.mime_type || 'image/png'};base64,${delta.data})\n`;
                } else if (d.event_type === 'step.start' && d.step) {
                  stepTypes.set(d.index ?? -1, d.step.type);
                  if (d.step.type === 'function_call') {
                    if (!msgs.value[idx].toolCalls) msgs.value[idx].toolCalls = [];
                    msgs.value[idx].toolCalls!.push({ id: d.step.id, name: d.step.name, arguments: d.step.arguments, signature: d.step.signature });
                  }
                } else if (d.event_type === 'error') {
                  msgs.value[idx].error = (d.error && d.error.message) || 'stream error';
                }
              } catch (e) { /* 忽略不完整事件 */ }
            }
          }
          scrollDown();
        }
      } else {
        const d = await r.json() as { steps?: InteractionStep[] };
        let content = '';
        let thinking = '';
        const toolCalls: ToolCall[] = [];
        for (const step of d.steps || []) {
          if (step.type === 'thought') (step.summary || []).forEach(c => { if (c.type === 'text' && c.text) thinking += c.text; });
          if (step.type === 'model_output') (step.content || []).forEach(c => {
            if (c.type === 'text' && c.text) content += c.text;
            else if (c.type === 'image' && c.data) content += `![image](data:${c.mime_type || 'image/png'};base64,${c.data})\n`;
          });
          if (step.type === 'function_call') toolCalls.push({ id: step.id, name: step.name, arguments: step.arguments, signature: step.signature });
        }
        msgs.value.push({ role: 'assistant', content: content || (toolCalls.length ? '' : '(无响应内容)'), thinking, toolCalls, showThinking: false });
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        const last = msgs.value[msgs.value.length - 1];
        if (last && last.role === 'assistant') last.error = '已停止生成';
        else msgs.value.push({ role: 'assistant', content: '', error: '已停止生成' });
      } else {
        msgs.value.push({ role: 'assistant', content: '', error: (e as Error).message });
      }
    } finally {
      busy.value = false;
      abortCtrl.value = null;
      scrollDown();
    }
  }

  function stopGeneration(): void {
    if (abortCtrl.value) abortCtrl.value.abort();
  }

  async function copyMessage(i: number): Promise<void> {
    const m = msgs.value[i];
    const text = (m.content || '') + (m.thinking ? '\n\n[思考过程]\n' + m.thinking : '');
    const { copy } = useClipboard({ legacy: true });
    await copy(text);
    copiedIdx.value = i;
    setTimeout(() => { if (copiedIdx.value === i) copiedIdx.value = -1; }, 1500);
  }

  function regenerate(): void {
    if (busy.value) return;
    // 弹出末尾的 assistant 消息与最后一条 user 消息，重新发送
    while (msgs.value.length && msgs.value[msgs.value.length - 1].role === 'assistant') msgs.value.pop();
    const lastUser = msgs.value[msgs.value.length - 1];
    if (!lastUser || lastUser.role !== 'user') { toastErr('没有可重新生成的对话'); return; }
    msgs.value.pop();
    draft.value = lastUser.content || '';
    selectedAttachments.value = lastUser.attachments ? [...lastUser.attachments] : (lastUser.images || []).map((data_url, index) => ({
      name: `image-${index + 1}`,
      mime_type: data_url.match(/^data:([^;]+)/u)?.[1] || 'image/png',
      data_url,
      kind: 'image' as const,
    }));
    send();
  }

  function useSuggestion(text: string): void {
    draft.value = text;
    focusTick.value++;
  }

  return {
    draft, selectedAttachments, busy, copiedIdx, focusTick, suggestions,
    msgs, scrollDown, isNearBottom, newChat, addFiles, handleFileUpload, removeAttachment,
    send, stopGeneration, copyMessage, regenerate, useSuggestion,
  };
}

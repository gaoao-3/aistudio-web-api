<script setup lang="ts">
// 输入区：自适应高度、多媒体附件（按钮/粘贴/拖拽）、模型快选、发送/停止
import { computed, nextTick, ref, watch } from 'vue';
import Icon from './Icon.vue';
import { useChat } from '../composables/useChat';
import { model, models } from '../composables/useCache';

const {
  draft, selectedAttachments, busy, focusTick,
  addFiles, handleFileUpload, removeAttachment, send, stopGeneration,
} = useChat();

const ta = ref<HTMLTextAreaElement | null>(null);
const mediaInput = ref<HTMLInputElement | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
const attachMenuOpen = ref(false);
const dragover = ref(false);

const modelOptions = computed(() => models.value.map(m => ({ title: m.id, value: m.id })));

function resizeTa(): void {
  const el = ta.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 200) + 'px';
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    onSend();
  }
}

function onSend(): void {
  if (busy.value) return;
  send().finally(() => nextTick(resizeTa));
  nextTick(resizeTa);
}

function onPaste(e: ClipboardEvent): void {
  const files = Array.from(e.clipboardData?.files || []);
  if (!files.length) return;
  e.preventDefault();
  addFiles(files);
}

function onDrop(e: DragEvent): void {
  dragover.value = false;
  const files = Array.from(e.dataTransfer?.files || []);
  if (files.length) addFiles(files);
}

function onFileChange(e: Event): void {
  attachMenuOpen.value = false;
  handleFileUpload(e);
}

function openPicker(kind: 'media' | 'file'): void {
  attachMenuOpen.value = false;
  (kind === 'media' ? mediaInput.value : fileInput.value)?.click();
}

watch(focusTick, () => nextTick(() => ta.value?.focus()));
</script>

<template>
  <div class="composer">
    <div
      class="composer-inner" :class="{ dragover }"
      @dragover.prevent="dragover = true"
      @dragleave.prevent="dragover = false"
      @drop.prevent="onDrop"
    >
      <div v-if="selectedAttachments.length" class="attach-preview">
        <div v-for="(attachment, idx) in selectedAttachments" :key="`${attachment.name}-${idx}`" class="attachment-preview">
          <img v-if="attachment.kind === 'image'" :src="attachment.data_url" :alt="attachment.name">
          <audio v-else-if="attachment.kind === 'audio'" :src="attachment.data_url" controls></audio>
          <video v-else-if="attachment.kind === 'video'" :src="attachment.data_url" controls></video>
          <div v-else class="attachment-file"><span class="attachment-file-icon">📄</span><span>{{ attachment.name }}</span></div>
          <button class="rm" :title="`移除 ${attachment.name}`" @click="removeAttachment(idx)">×</button>
        </div>
      </div>
      <div v-if="attachMenuOpen" class="attach-menu" @click.stop>
        <button type="button" class="attach-menu-item" @click="openPicker('media')">
          <span class="attach-menu-icon">🖼️</span>
          <span><strong>图片 / 视频</strong><small>相册、相机或摄像机</small></span>
        </button>
        <button type="button" class="attach-menu-item" @click="openPicker('file')">
          <span class="attach-menu-icon">📎</span>
          <span><strong>音频 / 文件</strong><small>音频、PDF、文本和代码</small></span>
        </button>
      </div>
      <div class="composer-row">
        <v-select
          v-if="modelOptions.length"
          v-model="model" :items="modelOptions"
          class="model-quick" density="compact" variant="plain" hide-details
        />
        <textarea
          ref="ta" v-model="draft" placeholder="输入提示词…" rows="1"
          @keydown="onKeydown" @input="resizeTa" @paste="onPaste"
        ></textarea>
        <input ref="mediaInput" type="file" accept="image/*,video/*" multiple hidden @change="onFileChange">
        <!-- 安卓部分 ROM 会按 accept 过滤掉文件管理器；文件入口放开选择范围，再由 addFiles 校验类型。 -->
        <input ref="fileInput" type="file" accept="*/*" multiple hidden @change="onFileChange">
        <button class="icon-btn" title="附加图片、音频或文件" @click="attachMenuOpen = !attachMenuOpen">
          <Icon name="image" />
        </button>
        <button
          class="send-btn" :class="{ stopping: busy }"
          :disabled="!busy && ((!draft.trim() && selectedAttachments.length === 0) || !model)"
          :title="busy ? '停止生成' : '发送'"
          @click="busy ? stopGeneration() : onSend()"
        >
          <Icon :name="busy ? 'stop' : 'send'" :size="20" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.model-quick {
  width: 170px;
  flex-shrink: 0;
  margin-bottom: 2px;
}
.model-quick :deep(.v-field) {
  background: var(--primary-container);
  border-radius: 8px;
  color: var(--primary-bright);
  font-size: 12px;
  font-family: var(--mono);
  --v-field-padding-start: 10px;
  --v-field-padding-end: 4px;
}
.model-quick :deep(.v-field__input) {
  padding-top: 5px;
  padding-bottom: 5px;
  min-height: 30px;
  color: var(--primary-bright);
}
</style>

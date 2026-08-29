<script setup lang="ts">
// API 密钥页
import { onMounted } from 'vue';
import Icon from '../components/Icon.vue';
import { useKeys } from '../composables/useKeys';
import { fmtDate } from '../utils';

const {
  keys, keysLoading, keyName, newKey, keyCopied, keyBusy,
  loadKeys, createKey, copyNewKey, deleteKey,
} = useKeys();

onMounted(loadKeys);

function onDeleteKey(id: string): void {
  if (!confirm('删除后使用该密钥的调用将立即失效，确定删除？')) return;
  deleteKey(id);
}

</script>

<template>
  <div class="page">
    <div class="page-title">API 密钥</div>
    <div class="page-sub">创建后完整密钥仅显示一次，请立即复制保存。密钥仅用于 API 鉴权，内置原生工具只在 WebUI 会话中可用。</div>

    <v-card class="mb-5" rounded="xl">
      <v-card-text class="flex gap-2 items-center flex-wrap">
        <v-text-field
          v-model="keyName" placeholder="密钥名称（如：我的手机）"
          style="flex: 1; min-width: 180px" hide-details @keydown.enter="createKey()"
        />
        <v-btn color="primary" :loading="keyBusy" @click="createKey()">
          <template #prepend><Icon name="plus" :size="18" /></template>
          创建密钥
        </v-btn>
      </v-card-text>
    </v-card>

    <v-alert v-if="newKey" type="success" class="mb-5" title="创建成功，完整密钥仅显示这一次：">
      <div class="flex gap-2 items-center flex-wrap mt-2">
        <code class="flex-1 min-w-[200px] font-mono text-[13px] bg-surface-2 px-3 py-2 rounded-[10px] break-all">{{ newKey }}</code>
        <v-btn variant="text" size="small" @click="copyNewKey()">
          <template #prepend><Icon :name="keyCopied ? 'check' : 'copy'" :size="15" /></template>
          {{ keyCopied ? '已复制' : '复制' }}
        </v-btn>
      </div>
    </v-alert>

    <div v-if="keysLoading" class="skel-list">
      <div v-for="i in 3" :key="i" class="skel-row">
        <div class="skeleton skel-circle"></div>
        <div class="skel-lines">
          <div class="skeleton skel-line w60"></div>
          <div class="skeleton skel-line w40"></div>
        </div>
      </div>
    </div>
    <div v-else-if="!keys.length" class="empty-hint">还没有密钥。环境变量 AISTUDIO_API_KEY 配置的密钥不在这里显示。</div>

    <template v-else>
      <div v-for="k in keys" :key="k.id" class="hist-row static">
        <Icon name="key" class="text-muted" />
        <div class="hist-preview">
          <div class="t">{{ k.name || '(未命名)' }}</div>
          <div class="meta">
            <span class="model-chip">{{ k.prefix }}…</span>
            <span>创建：{{ fmtDate(k.created_at) }}</span>
            <span>{{ k.last_used ? '最近使用：' + fmtDate(k.last_used) : '从未使用' }}</span>
          </div>
        </div>
        <button class="icon-btn" title="删除" @click="onDeleteKey(k.id)">
          <Icon name="trash" />
        </button>
      </div>
    </template>
  </div>
</template>

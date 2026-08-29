<script setup lang="ts">
// 本地聊天记录页
import { onMounted } from 'vue';
import Icon from '../components/Icon.vue';
import { useHistory } from '../composables/useHistory';
import { fmtDate } from '../utils';

const { history, historyLoading, loadHistory, historyPreview, openConversation, removeConversation } = useHistory();

onMounted(loadHistory);
</script>

<template>
  <div class="page">
    <div class="page-title">历史记录</div>
    <div class="page-sub">原生 generateContent 无状态运行，聊天记录仅保存在当前浏览器中。</div>

    <div v-if="historyLoading" class="skel-list">
      <div v-for="i in 4" :key="i" class="skel-row">
        <div class="skeleton skel-circle"></div>
        <div class="skel-lines">
          <div class="skeleton skel-line w60"></div>
          <div class="skeleton skel-line w40"></div>
        </div>
      </div>
    </div>
    <div v-else-if="!history.length" class="empty-hint">暂无本地历史记录</div>

    <template v-else>
      <div v-for="conversation in history" :key="conversation.id" class="hist-row" @click="openConversation(conversation)">
        <Icon name="chat" class="text-muted" />
        <div class="hist-preview">
          <div class="t">{{ historyPreview(conversation) }}</div>
          <div class="meta">
            <span class="model-chip">{{ conversation.model || '未选择模型' }}</span>
            <span>{{ fmtDate(conversation.updated_at) }}</span>
            <span>本地</span>
          </div>
        </div>
        <button class="icon-btn" title="清空" @click.stop="removeConversation(conversation.id)">
          <Icon name="trash" />
        </button>
      </div>
    </template>
  </div>
</template>

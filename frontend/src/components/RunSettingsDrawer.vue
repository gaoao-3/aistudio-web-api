<script setup lang="ts">
// 运行设置抽屉（原右侧 settings-panel，宽屏内嵌改为统一抽屉）
import { computed } from 'vue';
import Icon from './Icon.vue';
import { useView } from '../composables/useView';
import { cfg, clearCache, model, models } from '../composables/useCache';
import { useAuth } from '../composables/useAuth';
import { useChat } from '../composables/useChat';
import type { OnOff } from '../types';

const { runSettingsOpen } = useView();
const { token } = useAuth();
const { newChat } = useChat();

const modelItems = computed(() => models.value.map(m => ({ title: m.id, value: m.id })));

const thinkingOptions = [
  { label: '关闭', value: 'off' },
  { label: '低', value: 'low' },
  { label: '中', value: 'medium' },
  { label: '高', value: 'high' },
];

// cfg 里存的是 'on'/'off' 字符串，v-switch 用 boolean，这里做桥接
function onOffBridge(key: 'search' | 'codeExecution' | 'googleMaps' | 'urlContext' | 'stream' | 'safety') {
  return computed<boolean>({
    get: () => cfg.value[key] === 'on',
    set: v => { cfg.value[key] = (v ? 'on' : 'off') as OnOff; },
  });
}
const searchOn = onOffBridge('search');
const codeExecutionOn = onOffBridge('codeExecution');
const googleMapsOn = onOffBridge('googleMaps');
const urlContextOn = onOffBridge('urlContext');
const streamOn = onOffBridge('stream');
const safetyOn = onOffBridge('safety');

const normalizedModel = computed(() => model.value.replace(/^models\//u, '').toLowerCase());
const supportsTextTools = computed(() => !normalizedModel.value.includes('image') && !normalizedModel.value.includes('tts'));
const supportsGeminiTools = computed(() => normalizedModel.value.startsWith('gemini-') && supportsTextTools.value);

function onClearCache(): void {
  if (!confirm('确定要清理本地缓存（聊天历史和配置）吗？')) return;
  clearCache();
}
</script>

<template>
  <v-navigation-drawer v-model="runSettingsOpen" temporary location="right" width="340">
    <div class="flex items-center justify-between px-4 py-3 border-b border-border-soft">
      <span class="text-[15px] font-[600]">运行设置</span>
      <button class="icon-btn act" title="关闭" @click="runSettingsOpen = false"><Icon name="close" :size="18" /></button>
    </div>
    <div class="flex flex-col gap-5 pa-4">
      <div>
        <div class="field-label"><span>模型</span></div>
        <v-select v-model="model" :items="modelItems" />
      </div>
      <div>
        <div class="field-label"><span>Temperature</span><span class="val">{{ cfg.temperature }}</span></div>
        <v-slider v-model="cfg.temperature" :min="0" :max="2" :step="0.05" />
      </div>
      <div>
        <div class="field-label"><span>Top P</span><span class="val">{{ cfg.topP }}</span></div>
        <v-slider v-model="cfg.topP" :min="0" :max="1" :step="0.01" />
      </div>
      <div>
        <div class="field-label"><span>最大输出 Tokens</span></div>
        <v-text-field v-model.number="cfg.maxTokens" type="number" :min="1" class="w-full" />
      </div>
      <div>
        <div class="field-label"><span>思考等级</span></div>
        <v-btn-toggle v-model="cfg.thinking" mandatory class="w-full flex" density="comfortable">
          <v-btn v-for="o in thinkingOptions" :key="o.value" :value="o.value" class="flex-1" size="small">
            {{ o.label }}
          </v-btn>
        </v-btn-toggle>
      </div>
      <div class="flex items-center justify-between">
        <span>Google 搜索</span>
        <v-switch v-model="searchOn" />
      </div>
      <div class="flex items-center justify-between">
        <span>代码执行</span>
        <v-switch v-model="codeExecutionOn" :disabled="!supportsTextTools" />
      </div>
      <div class="flex items-center justify-between">
        <span>Google Maps</span>
        <v-switch v-model="googleMapsOn" :disabled="!supportsGeminiTools" />
      </div>
      <div class="flex items-center justify-between">
        <span>URL Context</span>
        <v-switch v-model="urlContextOn" :disabled="!supportsGeminiTools" />
      </div>
      <div class="flex items-center justify-between">
        <span>流式输出</span>
        <v-switch v-model="streamOn" />
      </div>
      <div class="flex items-center justify-between">
        <span>安全过滤</span>
        <v-switch v-model="safetyOn" />
      </div>
      <div>
        <div class="field-label"><span>API Token（鉴权启用时生效）</span></div>
        <v-text-field
          v-model="token" type="password"
          placeholder="留空表示未启用鉴权"
        />
      </div>
      <v-btn variant="outlined" @click="newChat()">
        <template #prepend><Icon name="plus" :size="18" /></template>
        新建对话
      </v-btn>
      <v-btn variant="text" color="error" @click="onClearCache">清理本地缓存</v-btn>
    </div>
  </v-navigation-drawer>
</template>

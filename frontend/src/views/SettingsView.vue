<script setup lang="ts">
// 服务设置页（数据驱动渲染 GET /config/runtime 返回的 settings）
import { onMounted } from 'vue';
import Icon from '../components/Icon.vue';
import { useRuntimeConfig } from '../composables/useRuntimeConfig';

const { runtimeCfg, loadRuntimeConfig, saveSetting } = useRuntimeConfig();

onMounted(loadRuntimeConfig);

function displayValue(v: string | number | boolean | null | undefined, unit?: string): string {
  if (v === null || v === undefined) return '未配置';
  if (typeof v === 'boolean') return v ? '开' : '关';
  if (typeof v === 'string' && !v) return '未配置';
  return unit ? `${v} ${unit}` : String(v);
}

function inputPlaceholder(sensitive?: boolean): string {
  if (sensitive) return '输入完整代理地址；未修改请直接保存';
  return '留空使用系统默认';
}
</script>

<template>
  <div class="page">
    <div class="page-title">服务设置</div>
    <div class="page-sub">服务端运行参数。标注「重启生效」的配置保存后需重启服务才会应用。</div>

    <div v-if="runtimeCfg.loading && !runtimeCfg.loaded" style="max-width: 640px">
      <div v-for="i in 3" :key="i" class="skeleton skel-card"></div>
    </div>

    <v-alert v-if="runtimeCfg.globalError" type="error" class="mb-4">{{ runtimeCfg.globalError }}</v-alert>

    <template v-if="runtimeCfg.loaded">
      <div class="flex gap-2 mb-4">
        <v-btn variant="text" size="small" :disabled="runtimeCfg.loading" @click="loadRuntimeConfig()">
          <template #prepend><Icon name="refresh" :size="15" /></template>
          重新加载
        </v-btn>
      </div>

      <v-card
        v-for="setting in runtimeCfg.settings"
        :key="setting.key"
        class="mb-4"
        style="max-width: 640px"
        rounded="xl"
      >
        <v-card-text>
          <div class="flex items-start gap-3 mb-3">
            <span class="modal-badge"><Icon name="cog" :size="20" /></span>
            <div>
              <h3 class="text-[15px] font-[500] text-text">
                {{ setting.label }}
                <span v-if="setting.restart_required" class="text-[11px] text-warn">（保存后重启生效）</span>
              </h3>
              <p class="text-[12px] text-muted">{{ setting.description }}</p>
            </div>
          </div>

          <v-switch
            v-if="setting.type === 'boolean'"
            :model-value="setting.input === true"
            @update:model-value="(v: boolean | null) => setting.input = v === true"
          />

          <template v-else-if="setting.type === 'mib' || setting.type === 'integer'">
            <v-text-field
              :model-value="typeof setting.input === 'number' ? setting.input : null"
              type="number"
              :min="setting.min"
              :max="setting.max"
              :step="setting.step ?? 1"
              :placeholder="`输入${setting.unit ? ' ' + setting.unit : '数值'}`"
              class="w-full"
              @update:model-value="(v: string) => setting.input = v === '' ? null : Number(v)"
            />
          </template>

          <v-select
            v-else-if="setting.type === 'enum'"
            :model-value="typeof setting.input === 'string' ? setting.input : null"
            :items="(setting.options || []).map(o => ({ title: o.label, value: o.value as string | number }))"
            class="w-full"
            @update:model-value="(v: string | number | null) => setting.input = v"
          />

          <v-text-field
            v-else
            :model-value="typeof setting.input === 'string' ? setting.input : ''"
            type="text"
            :placeholder="inputPlaceholder(setting.sensitive)"
            class="w-full"
            @update:model-value="(v: string) => setting.input = v"
          />

          <div class="field-hint">
            <span>当前生效：{{ displayValue(setting.effective, setting.unit) }}</span>
            <span>{{ setting.configured === null ? '未配置（使用默认值）' : '已配置：' + displayValue(setting.configured, setting.unit) }}</span>
          </div>

          <v-alert v-if="setting.error" type="error" class="mt-3">{{ setting.error }}</v-alert>
          <v-alert v-else-if="setting.notice" class="mt-3" :type="setting.restart_required ? 'warning' : 'success'">
            {{ setting.notice }}
          </v-alert>

          <div class="flex gap-2 mt-4">
            <v-btn
              color="primary" size="small"
              :loading="setting.saving" @click="saveSetting(setting.key)"
            >
              <template #prepend><Icon :name="setting.saving ? 'loader' : 'save'" :size="16" :class="{ spin: setting.saving }" /></template>
              {{ setting.saving ? '保存中…' : '保存' }}
            </v-btn>
          </div>
        </v-card-text>
      </v-card>
    </template>
  </div>
</template>

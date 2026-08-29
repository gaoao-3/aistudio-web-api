<script setup lang="ts">
// Cookie 导入模态（原 index.html Cookie 模态移植）
import { useAccounts } from '../composables/useAccounts';

const { cookieModal, importCookies } = useAccounts();
</script>

<template>
  <v-dialog v-model="cookieModal.open" max-width="520">
    <v-card rounded="xl" title="导入 Cookie">
      <v-card-text>
        <p class="text-[12px] text-muted mb-4">从 myaccount.google.com 复制 Cookie，快速添加账号</p>
        <div class="flex flex-col gap-4">
          <div>
            <div class="field-label"><span>Cookie（每行一个或用分号分隔）</span></div>
            <v-textarea
              v-model="cookieModal.cookies" :rows="5"
              placeholder="从 myaccount.google.com 复制" hide-details
            />
          </div>
          <div>
            <div class="field-label"><span>名称（可选）</span></div>
            <v-text-field v-model="cookieModal.name" placeholder="My Account" />
          </div>
          <div>
            <div class="field-label"><span>邮箱（可选）</span></div>
            <v-text-field v-model="cookieModal.email" placeholder="user@gmail.com" />
          </div>
        </div>
      </v-card-text>
      <v-card-actions>
        <div class="flex justify-end gap-2 w-full">
          <v-btn variant="text" size="small" @click="cookieModal.open = false">取消</v-btn>
          <v-btn color="primary" size="small" :loading="cookieModal.importing" @click="importCookies()">
            {{ cookieModal.importing ? '导入中…' : '导入' }}
          </v-btn>
        </div>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import { applyPresetToCssVars } from './composables/useTheme';
import AppShell from './components/AppShell.vue';
import ToastHost from './components/ToastHost.vue';

onMounted(applyPresetToCssVars);
</script>

<template>
  <v-app class="h-full">
    <AppShell />
    <ToastHost />
  </v-app>
</template>

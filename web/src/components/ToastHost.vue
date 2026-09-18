<template>
  <div class="toast-host">
    <div v-for="t in toasts" :key="t.id" class="toast" :class="`toast-${t.type}`" @click="dismissToast(t.id)">
      {{ t.message }}
    </div>
  </div>
</template>

<script setup>
import { toasts, dismissToast } from '../utils/toast.js';
</script>

<style scoped>
.toast-host { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); z-index: 999; display: flex; flex-direction: column; gap: 8px; width: min(92vw, 420px); }
.toast { padding: 10px 14px; border-radius: 8px; background: #fff; border: 1px solid var(--border); box-shadow: 0 4px 16px rgba(27,31,36,.16); font-size: 13px; cursor: pointer; white-space: pre-wrap; }
.toast-success { border-color: rgba(26,127,55,.5); color: var(--success); }
.toast-error { border-color: rgba(207,34,46,.5); color: var(--danger); }
</style>

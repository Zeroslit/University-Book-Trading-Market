<template>
  <div class="empty">
    <div style="font-size:28px">{{ icon }}</div>
    <p>{{ text }}</p>
    <slot />
  </div>
</template>

<script setup>
import { t } from '../i18n/index.js';
defineProps({
  text: { type: String, default: t('暂无数据') },
  icon: { type: String, default: '📭' },
});
</script>

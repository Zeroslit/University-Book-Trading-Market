<template>
  <div class="empty">
    <div style="font-size:28px">{{ icon }}</div>
    <p>{{ text }}</p>
    <slot />
  </div>
</template>

<script setup>
defineProps({
  text: { type: String, default: '暂无数据' },
  icon: { type: String, default: '📭' },
});
</script>

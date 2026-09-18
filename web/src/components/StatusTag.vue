<template>
  <span class="tag" :class="entry.tag">{{ entry.label }}</span>
</template>

<script setup>
import { computed } from 'vue';
import { dict } from '../utils/format.js';

const props = defineProps({
  map: { type: Object, required: true },
  value: { type: [String, Number], default: '' },
});
const entry = computed(() => dict(props.map, props.value));
</script>

<template>
  <div>
    <div class="chips">
      <div v-for="(url, index) in modelValue" :key="url + index" class="upload-item">
        <img :src="imageUrl(url)" :alt="$t('已上传图片')" />
        <button type="button" class="upload-remove" @click="remove(index)">×</button>
      </div>
      <label v-if="modelValue.length < max" class="upload-add">
        <input type="file" accept="image/*" multiple hidden @change="onPick($event)" />
        <span>＋<br /><span class="small">{{ $t('相册') }}</span></span>
      </label>
      <label v-if="modelValue.length < max && camera" class="upload-add">
        <input type="file" accept="image/*" capture="environment" hidden @change="onPick($event)" />
        <span>📷<br /><span class="small">{{ $t('拍照') }}</span></span>
      </label>
    </div>
    <p class="small muted" style="margin:6px 0 0">{{ $t('最多 {0} 张，前端自动压缩到长边 ≤ 1080px 后上传（{1}/{2}）', [max, modelValue.length, max]) }}</p>
    <p v-if="uploading" class="small">{{ $t('图片上传中…') }}</p>
  </div>
</template>

<script setup>
import { t } from '../i18n/index.js';
import { ref } from 'vue';
import { compressImage, imageUrl } from '../utils/image.js';
import { uploadApi } from '../api/index.js';
import { toastError } from '../utils/toast.js';

const props = defineProps({
  modelValue: { type: Array, default: () => [] },
  max: { type: Number, default: 9 },
  camera: { type: Boolean, default: true },
});
const emit = defineEmits(['update:modelValue']);
const uploading = ref(false);

async function onPick(event) {
  const files = Array.from(event.target.files || []);
  event.target.value = '';
  if (files.length === 0) return;
  uploading.value = true;
  const next = [...props.modelValue];
  try {
    for (const file of files) {
      if (next.length >= props.max) break;
      const compressed = await compressImage(file);
      const saved = await uploadApi.image(compressed);
      next.push(saved.url);
    }
    emit('update:modelValue', next);
  } catch (err) {
    toastError(err?.message || t('图片上传失败'));
  } finally {
    uploading.value = false;
  }
}

function remove(index) {
  const next = [...props.modelValue];
  next.splice(index, 1);
  emit('update:modelValue', next);
}
</script>

<style scoped>
.upload-item { position: relative; width: 76px; height: 76px; }
.upload-item img { width: 100%; height: 100%; object-fit: cover; border-radius: 8px; border: 1px solid var(--border); }
.upload-remove { position: absolute; top: -6px; right: -6px; width: 20px; height: 20px; border-radius: 50%; border: none; background: var(--danger); color: #fff; cursor: pointer; line-height: 1; }
.upload-add { width: 76px; height: 76px; border: 1px dashed var(--border); border-radius: 8px; display: flex; align-items: center; justify-content: center; text-align: center; cursor: pointer; font-size: 18px; color: var(--text-muted); background: #fff; }
</style>

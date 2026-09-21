import { t } from '../i18n/index.js';
<template>
  <div class="card" style="text-align:center">
    <h2>404</h2>
    <p class="muted">{{ $t('页面不存在或已被移动') }}</p>
    <RouterLink class="btn btn-primary" to="/">{{ $t('返回首页') }}</RouterLink>
  </div>
</template>

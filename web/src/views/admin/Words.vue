<template>
  <div>
    <div class="card">
      <div class="row-between wrap">
        <div>
          <div class="bold">{{ $t('违禁词库（四级）') }}</div>
          <div class="small muted">
            {{ $t('L1 提示（打码提醒）· L2 拦截（拦截并提示修改）· L3 违规（拦截 + 扣分 + 记违规）· L4 严重（删除内容 + 转人工工单 + 视情节封禁）') }}
          </div>
        </div>
        <div class="chips">
          <select v-model="filters.level" style="width:auto" @change="load">
            <option value="">{{ $t('全部级别') }}</option>
            <option value="L1">L1</option><option value="L2">L2</option><option value="L3">L3</option><option value="L4">L4</option>
          </select>
          <select v-model="filters.status" style="width:auto" @change="load">
            <option value="">{{ $t('全部状态') }}</option>
            <option value="active">{{ $t('生效') }}</option>
            <option value="disabled">{{ $t('停用') }}</option>
            <option value="whitelist">{{ $t('白名单') }}</option>
          </select>
        </div>
      </div>

      <div class="grid mt12" style="grid-template-columns:repeat(auto-fill,minmax(140px,1fr))">
        <div><label>{{ $t('词条') }}</label><input v-model.trim="form.word" :placeholder="$t('展示名，如 手机号')" /></div>
        <div><label>{{ $t('匹配方式') }}</label>
          <select v-model="form.matchType"><option value="keyword">{{ $t('关键词') }}</option><option value="regex">{{ $t('正则') }}</option></select>
        </div>
        <div><label>{{ $t('级别') }}</label>
          <select v-model="form.level"><option value="L1">L1</option><option value="L2">L2</option><option value="L3">L3</option><option value="L4">L4</option></select>
        </div>
        <div><label>{{ $t('作用域') }}</label>
          <select v-model="form.scope">
            <option value="school">{{ $t('本校') }}</option>
            <option v-if="auth.isPlatformAdmin" value="global">{{ $t('全局') }}</option>
          </select>
        </div>
        <div><label>{{ $t('分类') }}</label><input v-model.trim="form.category" :placeholder="$t('如 引流/盗版')" /></div>
        <div><label>{{ $t('扣分（负数为扣分，可空）') }}</label><input v-model.trim="form.scoreDelta" type="number" /></div>
      </div>
      <label v-if="form.matchType === 'regex'">{{ $t('正则表达式内容（如 1[3-9]\\\\d{9}）') }}</label>
      <input v-if="form.matchType === 'regex'" v-model.trim="form.pattern" />
      <label>{{ $t('备注') }}</label>
      <input v-model.trim="form.remark" />
      <button class="btn btn-primary mt12" @click="create">{{ $t('新增词条') }}</button>
      <p class="small muted mt8">
        {{ $t('归一化检测：去空格与符号、全角转半角、繁简转换、拼音谐音还原；命中会记录 word_hits 便于人工复核。') }}
      </p>
    </div>

    <div class="card">
      <table class="table">
        <thead><tr><th>ID</th><th>{{ $t('词条') }}</th><th>{{ $t('级别') }}</th><th>{{ $t('方式') }}</th><th>{{ $t('分类') }}</th><th>{{ $t('处置') }}</th><th>{{ $t('扣分') }}</th><th>{{ $t('作用域') }}</th><th>{{ $t('状态') }}</th><th>{{ $t('操作') }}</th></tr></thead>
        <tbody>
          <tr v-for="w in words" :key="w.id">
            <td>{{ w.id }}</td>
            <td>{{ w.word }}<div class="small muted">{{ w.normalized }}</div></td>
            <td><StatusTag :map="WORD_LEVEL" :value="w.level" /></td>
            <td>{{ w.match_type === 'regex' ? $t('正则') : $t('关键词') }}</td>
            <td class="small">{{ w.category || '—' }}</td>
            <td class="small">{{ w.action }}</td>
            <td>{{ w.score_delta ?? 0 }}</td>
            <td class="small">{{ w.scope === 'global' ? $t('全局') : `${$t('本校 #{0}', [w.school_id])}` }}</td>
            <td>{{ w.status }}</td>
            <td>
              <button class="btn btn-sm" @click="toggle(w)">{{ w.status === 'active' ? $t('停用') : $t('启用') }}</button>
              <button class="btn btn-sm" @click="toggleWhite(w)">{{ w.status === 'whitelist' ? $t('移出白名单') : $t('白名单') }}</button>
              <button class="btn btn-sm btn-danger" @click="remove(w)">{{ $t('删除') }}</button>
            </td>
          </tr>
        </tbody>
      </table>
      <EmptyState v-if="words.length === 0" :text="$t('词库为空')" icon="🚫" />
    </div>

    <div class="card">
      <div class="bold">{{ $t('命中记录（证据链）') }}</div>
      <select v-model="filters.hitLevel" style="width:auto;margin-top:8px" @change="loadHits">
        <option value="">{{ $t('全部级别') }}</option>
        <option value="L1">L1</option><option value="L2">L2</option><option value="L3">L3</option><option value="L4">L4</option>
      </select>
      <table class="table mt8">
        <thead><tr><th>{{ $t('时间') }}</th><th>{{ $t('用户') }}</th><th>{{ $t('命中词') }}</th><th>{{ $t('级别') }}</th><th>{{ $t('场景') }}</th><th>{{ $t('目标') }}</th><th>{{ $t('匹配文本') }}</th><th>{{ $t('位置') }}</th><th>{{ $t('处置') }}</th></tr></thead>
        <tbody>
          <tr v-for="h in hits" :key="h.id">
            <td class="small">{{ formatTime(h.created_at) }}</td>
            <td>{{ h.user_id }}</td>
            <td>{{ h.word }}</td>
            <td><StatusTag :map="WORD_LEVEL" :value="h.level" /></td>
            <td class="small">{{ h.scene }}</td>
            <td class="small">{{ h.target_type }}#{{ h.target_id }}</td>
            <td class="small">{{ h.matched_text }}</td>
            <td>{{ h.position }}</td>
            <td class="small">{{ h.action_taken }}</td>
          </tr>
        </tbody>
      </table>
      <Pager :page="hitPage" :page-size="20" :total="hitTotal" :has-more="hitHasMore" @change="loadHits" />
    </div>
  </div>
</template>

<script setup>
import { t } from '../../i18n/index.js';
import { onMounted, reactive, ref, watch } from 'vue';
import { wordApi } from '../../api/index.js';
import { WORD_LEVEL, formatTime } from '../../utils/format.js';
import { useScope } from '../../utils/scope.js';
import { toastError, toastOk } from '../../utils/toast.js';
import EmptyState from '../../components/EmptyState.vue';
import Pager from '../../components/Pager.vue';
import StatusTag from '../../components/StatusTag.vue';

const { auth, schoolId, ready } = useScope();
const words = ref([]);
const hits = ref([]);
const filters = reactive({ level: '', status: '', hitLevel: '' });
const form = reactive({ word: '', pattern: '', matchType: 'keyword', level: 'L2', scope: 'school', category: '', scoreDelta: '', remark: '' });
const hitPage = ref(1);
const hitTotal = ref(0);
const hitHasMore = ref(false);

async function load() {
  if (!ready.value) { words.value = []; return; }
  words.value = await wordApi.list({ level: filters.level || undefined, status: filters.status || undefined }, schoolId.value);
}

async function loadHits(nextPage = 1) {
  if (!ready.value) { hits.value = []; return; }
  hitPage.value = nextPage;
  const data = await wordApi.hits({ level: filters.hitLevel || undefined, page: hitPage.value, pageSize: 20 }, schoolId.value);
  hits.value = data.list;
  hitTotal.value = data.total;
  hitHasMore.value = data.hasMore;
}

async function create() {
  if (!form.word) { toastError(t('请填写词条名')); return; }
  if (form.matchType === 'regex' && !form.pattern) { toastError(t('请填写正则表达式')); return; }
  try {
    await wordApi.create({
      word: form.matchType === 'regex' ? form.pattern : form.word,
      level: form.level, category: form.category || undefined, matchType: form.matchType,
      scope: form.scope, scoreDelta: form.scoreDelta === '' ? undefined : Number(form.scoreDelta),
      remark: form.remark || undefined,
    }, schoolId.value);
    toastOk(t('词条已新增'));
    form.word = ''; form.pattern = ''; form.category = ''; form.remark = ''; form.scoreDelta = '';
    await load();
  } catch (err) {
    toastError(err?.message || t('新增失败'));
  }
}

async function toggle(w) {
  try {
    await wordApi.update(w.id, { status: w.status === 'active' ? 'disabled' : 'active' }, schoolId.value);
    await load();
  } catch (err) {
    toastError(err?.message || t('更新失败'));
  }
}

async function toggleWhite(w) {
  try {
    await wordApi.update(w.id, { status: w.status === 'whitelist' ? 'active' : 'whitelist' }, schoolId.value);
    toastOk(t('已更新（白名单用于避免教材书名误伤）'));
    await load();
  } catch (err) {
    toastError(err?.message || t('更新失败'));
  }
}

async function remove(w) {
  if (!window.confirm(`${t('确认删除词条「{0}」？', [w.word])}`)) return;
  try {
    await wordApi.remove(w.id, schoolId.value);
    toastOk(t('已删除'));
    await load();
  } catch (err) {
    toastError(err?.message || t('删除失败'));
  }
}

watch(schoolId, () => { load(); loadHits(1); });
onMounted(() => { load(); loadHits(1); });
</script>

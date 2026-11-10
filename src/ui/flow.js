'use strict';

// 미리보기 → 실행 공통 흐름(#255)의 판정 부분. 화면과 명령 실행(#253)에 매이지 않는 순수 함수만 둔다.
// - 파일을 바꾸는 명령은 먼저 dryRun으로 미리보기하고, 그 결과의 지문(fingerprint)을 실행 요청에 함께 보낸다.
// - 실행 직전에 다시 미리보기해 지문이 다르면 실행하지 않고 새 미리보기를 보여 준다(그사이 폴더가 바뀜).
// - 덮어쓰기(force)와 영구 삭제(permanent)는 기본으로 끄고, 켜면 미리보기 화면에서 한 번 더 확인을 받는다.

const crypto = require('node:crypto');
const { html } = require('./html');
const { summaryCards, table, badge } = require('./layout');

// 위험한 옵션과 그 확인 칸. 옵션을 켠 실행 요청은 확인 칸(confirm-<이름>=yes)도 있어야 실행한다.
const DANGEROUS_OPTIONS = {
  force: { label: '덮어쓰기', warning: '이미 있는 파일을 덮어씁니다. 덮어쓴 파일은 되돌릴 수 없습니다.' },
  permanent: { label: '영구 삭제', warning: '휴지통을 거치지 않고 영구 삭제합니다. 되돌릴 수 없습니다.' },
};

// JSON으로 옮길 수 없는 값(Set, Map, Error, bigint, undefined)을 바꾸고 객체 키를 정렬해 늘 같은 글자를 만든다.
function canonical(value) {
  if (value instanceof Set) return [...value].map(canonical).sort(compareJson);
  if (value instanceof Map) return canonical(Object.fromEntries(value));
  if (value instanceof Error) return { error: value.message };
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined && typeof value[key] !== 'function') out[key] = canonical(value[key]);
    }
    return out;
  }
  return value;
}

function compareJson(a, b) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

// 미리보기의 지문. 명령, 인자, 옵션, 미리보기 결과가 하나라도 다르면 달라진다.
// 미리보기 결과에서 실행과 상관없이 매번 달라지는 값(진행 시각 등)은 volatile에 키 이름으로 넣어 뺀다.
function fingerprint({ command, args = [], options = {}, preview }, { volatile = [] } = {}) {
  const drop = new Set(volatile);
  const strip = (value) => {
    if (Array.isArray(value)) return value.map(strip);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !drop.has(key)).map(([key, v]) => [key, strip(v)]));
    return value;
  };
  const text = JSON.stringify(canonical({ command, args, options, preview: strip(canonical(preview)) }));
  return crypto.createHash('sha256').update(text).digest('hex');
}

// 실행 요청을 받을지 정한다. form은 실행 폼에서 받은 값, fresh는 실행 직전에 다시 만든 미리보기의 지문이다.
// 돌려주는 값: { action: 'execute' } | { action: 'reject', reason } | { action: 'repreview', reason }
// - reject: 미리보기 없이 온 요청, 위험한 옵션의 확인이 없는 요청. 아무것도 하지 않고 사유를 알린다.
// - repreview: 지문이 달라 실행하지 않고 새 미리보기를 보여 줄 때.
function decideExecution(form, fresh) {
  const submitted = typeof form.fingerprint === 'string' ? form.fingerprint : '';
  if (!/^[0-9a-f]{64}$/.test(submitted)) return { action: 'reject', reason: '미리보기를 거치지 않은 실행 요청이라 실행하지 않았습니다. 먼저 미리보기를 보세요.' };
  for (const [name, { label }] of Object.entries(DANGEROUS_OPTIONS)) {
    if (isOn(form[name]) && form[`confirm-${name}`] !== 'yes') {
      return { action: 'reject', reason: `${label}를 켰지만 한 번 더 확인하지 않아 실행하지 않았습니다. 미리보기 화면에서 확인 칸을 체크하세요.` };
    }
  }
  if (!crypto.timingSafeEqual(Buffer.from(submitted), Buffer.from(fresh))) {
    return { action: 'repreview', reason: '미리보기 뒤에 폴더 내용이 바뀌어 실행하지 않았습니다. 새 미리보기를 확인한 뒤 다시 실행하세요.' };
  }
  return { action: 'execute' };
}

function isOn(value) {
  return value === 'on' || value === 'yes' || value === 'true' || value === '1';
}

// 켠 위험 옵션의 경고와 확인 칸(미리보기 화면의 실행 폼 안에 넣는다).
function dangerConfirmations(options) {
  return Object.entries(DANGEROUS_OPTIONS)
    .filter(([name]) => isOn(options[name]))
    .map(([name, { label, warning }]) => html`<div class="alert alert-warning" role="alert"><strong>${label}</strong>: ${warning}
<label><input type="checkbox" name="confirm-${name}" value="yes" required> ${label}를 이해했고 실행합니다</label></div>`);
}

// 실행 결과 항목: { status: 'moved' | 'done' | 'skipped' | 'kept' | 'failed', path, detail?, reason? }
// 실패, 건너뜀·남김을 위에 두고 나머지는 원래 순서대로 둔다.
const STATUS_ORDER = { failed: 0, skipped: 1, kept: 1, warning: 1 };
function orderResults(items) {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (STATUS_ORDER[a.item.status] ?? 2) - (STATUS_ORDER[b.item.status] ?? 2) || a.index - b.index)
    .map(({ item }) => item);
}

function countResults(items) {
  const count = (statuses) => items.filter((item) => statuses.includes(item.status)).length;
  return { done: count(['moved', 'done']), skipped: count(['skipped', 'kept']), failed: count(['failed']) };
}

// 결과 요약 카드(이동·건너뜀·실패 수)와 사유가 붙은 표. doneLabel은 명령에 맞춘 이름(이동, 복사, 휴지통으로 보냄 등)이다.
function resultSection(items, { doneLabel = '이동' } = {}) {
  const counts = countResults(items);
  const cards = summaryCards([
    { label: doneLabel, value: counts.done, tone: 'ok' },
    { label: '건너뜀', value: counts.skipped, tone: counts.skipped ? 'warning' : undefined },
    { label: '실패', value: counts.failed, tone: counts.failed ? 'error' : undefined },
  ]);
  const rows = orderResults(items).map((item) => [badge(item.status, item.status === 'moved' || item.status === 'done' ? doneLabel : undefined), item.path, item.reason ?? item.detail ?? '']);
  return html`${cards}${table([{ label: '상태', width: '7.5em' }, { label: '경로', width: '55%' }, { label: '사유·내용' }], rows)}`;
}

module.exports = { DANGEROUS_OPTIONS, canonical, fingerprint, decideExecution, dangerConfirmations, orderResults, countResults, resultSection, isOn };

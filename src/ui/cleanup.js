'use strict';

// 찾기·지우기 화면(#259)의 결과 표. 작업 결과 페이지(jobPages.resultPage)의 views로 꽂는다.
// outcome.result는 find-*/remove-* 함수의 결과를 JSON으로 옮긴 것이다(serialize.toPlain).
// 파일 설명·묶음 이름·주의 문구는 CLI 보고와 같은 함수를 쓴다.

const path = require('node:path');
const { formatSize } = require('../commands');
const { describeVideo, groupLabel, groupCautions } = require('../duplicates');
const { criteriaText } = require('../lowQuality');
const { html } = require('./html');
const { summaryCards, badge, table, alertBox } = require('./layout');

const relativeTo = (target) => (p) => path.relative(target, p) || '.';

// 영상 열: 해상도(보이는 크기가 다르면 함께), 비트레이트, 길이, 크기
function resolution(file) {
  if (file.width == null || file.height == null) return '모름';
  const shown = file.displayWidth != null && file.displayHeight != null && (file.displayWidth !== file.width || file.displayHeight !== file.height);
  return shown ? `${file.width}x${file.height} (보이는 크기 ${file.displayWidth}x${file.displayHeight})` : `${file.width}x${file.height}`;
}
const bitrate = (file) => (file.bitrate == null ? '모름' : `${Math.round(file.bitrate / 1000)}kbps`);
function duration(seconds) {
  if (seconds == null) return '모름';
  const total = Math.round(seconds);
  const pad = (n) => String(n).padStart(2, '0');
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return h > 0 ? `${h}:${pad(m)}:${pad(total % 60)}` : `${m}:${pad(total % 60)}`;
}
const size = (bytes) => (bytes == null ? '' : formatSize(bytes));

// 찾기 명령에서 판단하지 않은 파일(판단 못함·건너뜀 등)의 표.
function otherTable(rel, groups) {
  const rows = groups.flatMap(([label, tone, items]) => items.map((item) => [rel(item.path), badge(tone, label), item.reason]));
  if (rows.length === 0) return '';
  return html`<h2>살펴보지 못한 파일</h2>
${table([{ label: '파일', width: '45%' }, { label: '상태', width: '15%' }, { label: '사유' }], rows)}`;
}

function targetLine(result) {
  return html`<p>타겟: <code>${result.target}</code></p>`;
}

// find-broken
function findBrokenView(outcome) {
  const r = outcome.result;
  const rel = relativeTo(r.target);
  const rows = [
    ...r.broken.map((item) => [rel(item.path), badge('failed', '깨짐'), size(item.size), item.reason]),
    ...r.suspect.map((item) => [rel(item.path), badge('warning', '의심'), size(item.size), item.reason]),
  ];
  return html`${targetLine(r)}
${summaryCards([
    { label: '살펴본 파일', value: r.checked },
    { label: '깨짐', value: r.broken.length, tone: r.broken.length > 0 ? 'error' : 'ok' },
    { label: '의심', value: r.suspect.length, tone: r.suspect.length > 0 ? 'warning' : undefined },
    { label: '판단 못함', value: r.unreadable.length },
    { label: '건너뜀', value: r.skipped.length },
  ])}
${table([{ label: '파일', width: '40%' }, { label: '판정', width: '10%' }, { label: '크기', width: '12%' }, { label: '사유' }], rows, { empty: '깨졌거나 의심되는 파일이 없습니다.' })}
${otherTable(rel, [['판단 못함', 'warning', r.unreadable], ['건너뜀', 'skipped', r.skipped]])}`;
}

// 영상 묶음 하나: 남길 파일과 지울 후보를 나눠 보인다.
function groupSection(rel, title, group, cautions) {
  const rows = group.files.map((file) => {
    const keep = file.path === group.keep.path;
    return [rel(file.path), keep ? html`${badge('kept', '남길 파일')} ${group.keep.reason}` : badge('warning', '지울 후보'), resolution(file), duration(file.duration), size(file.size)];
  });
  return html`<h3>${title}</h3>
${cautions.map((caution) => alertBox('warning', caution))}
${table([{ label: '파일', width: '34%' }, { label: '구분', width: '24%' }, { label: '해상도', width: '18%' }, { label: '길이', width: '10%' }, { label: '크기' }], rows)}`;
}

// find-duplicates
function findDuplicatesView(outcome) {
  const r = outcome.result;
  const rel = relativeTo(r.target);
  const byLength = r.metadataGroups.filter((group) => !group.alsoNamed);
  const named = r.groups.map((group) => groupSection(rel, `중복 후보: ${groupLabel(group)} (${group.files.length}개)`, group, groupCautions(group)));
  const lengths = byLength.map((group) => groupSection(
    rel,
    `길이가 같은 영상: ${duration(group.duration)}, 화면 비율 ${group.aspect}${group.sameSize ? ', 크기도 같음' : ''} (${group.files.length}개)`,
    group,
    group.keep.doubt == null ? [] : [group.keep.doubt],
  ));
  const conflicts = r.conflicts.map((item) => ({ path: item.path, reason: `번호가 여럿: ${item.numbers.join(', ')}` }));
  return html`${targetLine(r)}
${summaryCards([
    { label: '살펴본 영상', value: r.checked },
    { label: '이름이 같은 묶음', value: r.groups.length, tone: r.groups.length > 0 ? 'warning' : 'ok' },
    { label: '길이가 같은 묶음', value: byLength.length },
    { label: '길이 모름', value: r.unknownMetadata },
  ])}
${r.groups.length === 0 && byLength.length === 0 ? html`<p class="muted">중복 후보가 없습니다.</p>` : ''}
${named}
${lengths.length > 0 ? html`<h2>이름은 다르지만 길이가 같은 영상</h2><p class="muted">다른 영상일 수 있어 remove-duplicates는 이 묶음을 지우지 않습니다.</p>${lengths}` : ''}
${otherTable(rel, [['번호가 여럿', 'skipped', conflicts], ['길이·해상도 못 읽음', 'warning', r.metadataErrors], ['판단 못함', 'warning', r.unreadable], ['건너뜀', 'skipped', r.skipped]])}`;
}

// find-low-quality
function findLowQualityView(outcome) {
  const r = outcome.result;
  const rel = relativeTo(r.target);
  const rows = r.low.map((file) => [rel(file.path), resolution(file), bitrate(file), duration(file.duration), size(file.size), file.reasons.join(', ')]);
  return html`${targetLine(r)}
<p>기준: ${criteriaText(r.criteria)}</p>
${summaryCards([
    { label: '살펴본 영상', value: r.checked },
    { label: '저화질', value: r.low.length, tone: r.low.length > 0 ? 'warning' : 'ok' },
    { label: '판단 못함', value: r.unreadable.length },
    { label: '건너뜀', value: r.skipped.length },
  ])}
${table([{ label: '파일', width: '30%' }, { label: '해상도', width: '18%' }, { label: '비트레이트', width: '11%' }, { label: '길이', width: '9%' }, { label: '크기', width: '10%' }, { label: '사유' }], rows, { empty: '기준 미만인 영상이 없습니다.' })}
${otherTable(rel, [['판단 못함', 'warning', r.unreadable], ['건너뜀', 'skipped', r.skipped]])}`;
}

// 지우기 결과의 상태 알림. 미리보기(지울 목록), 확인값이 달라 멈춤, 휴지통으로 보냄.
function removalState(r) {
  if (r.mismatch) return alertBox('error', '목록이 확인값을 만든 때와 달라 아무것도 지우지 않았습니다. 새 목록을 확인하세요.');
  if (r.confirmed) return alertBox(r.failed.length > 0 ? 'warning' : 'success', `휴지통으로 ${r.removed.length}개를 보냈습니다.${r.failed.length > 0 ? ` 실패 ${r.failed.length}개.` : ''}`);
  if (r.removals.length === 0) return alertBox('info', '지울 파일이 없습니다.');
  return alertBox('info', `아직 지우지 않았습니다. 아래 ${r.removals.length}개를 확인한 뒤 실행하면 휴지통으로 보냅니다.`);
}

// 지울(지운) 파일 한 줄의 설명 열. 명령마다 다르다.
const DESCRIBE = {
  'remove-broken': (item) => [size(item.size), item.reason],
  'remove-duplicates': (item) => [describeVideo(item), ''],
  'remove-low-quality': (item) => [`${resolution(item)}, ${bitrate(item)}, ${duration(item.duration)}, ${size(item.size)}`, (item.reasons ?? []).join(', ')],
};

// remove-broken, remove-duplicates, remove-low-quality
function removeView(outcome) {
  const r = outcome.result;
  const rel = relativeTo(r.target);
  const describe = DESCRIBE[outcome.command];
  const duplicates = outcome.command === 'remove-duplicates';
  const setLabel = (item) => (duplicates && r.sets[item.set] ? `${r.sets[item.set].label} (남길 파일 ${rel(r.sets[item.set].keep.path)})` : '');
  const removedPaths = new Set(r.removed.map((item) => item.path));
  const listed = r.confirmed ? r.removals.filter((item) => removedPaths.has(item.path)) : r.removals;
  const doneLabel = r.confirmed ? '휴지통으로 보냄' : '지울 파일';
  const rows = [
    ...listed.map((item) => [rel(item.path), badge(r.confirmed ? 'done' : 'warning', doneLabel), ...describe(item), setLabel(item)]),
    ...r.failed.map((item) => [rel(item.path), badge('failed'), '', item.reason, setLabel(item)]),
    // 남긴 파일: 사유(영구 삭제될 크기, 휴지통 설정, 방금 바뀜 등)를 함께 보인다.
    ...r.kept.map((item) => [rel(item.path), badge('kept'), item.file ? describe(item.file)[0] : '', item.reason, setLabel(item)]),
  ];
  const columns = [{ label: '파일', width: '30%' }, { label: '구분', width: '13%' }, { label: '내용', width: '20%' }, { label: '사유' }];
  if (duplicates) columns.push({ label: '묶음', width: '20%' });
  const cells = duplicates ? rows : rows.map((row) => row.slice(0, 4));
  const others = [['판단 못함', 'warning', r.unreadable], ['건너뜀', 'skipped', r.skipped]];
  if (r.suspect) others.unshift(['의심(지우지 않음)', 'warning', r.suspect]);
  if (r.conflicts) others.unshift(['번호가 여럿', 'skipped', r.conflicts.map((item) => ({ path: item.path, reason: item.numbers.join(', ') }))]);
  return html`${targetLine(r)}
${r.criteria ? html`<p>기준: ${criteriaText(r.criteria)}</p>` : ''}
${removalState(r)}
${duplicates && r.sets.some((set) => set.doubt != null) ? r.sets.filter((set) => set.doubt != null).map((set) => alertBox('warning', `${set.label}: ${set.doubt}`)) : ''}
${duplicates && r.lengthOnly > 0 ? html`<p class="muted">길이만 같은 묶음 ${r.lengthOnly}개는 이름이 달라 다른 영상일 수 있어 지우지 않습니다.</p>` : ''}
${table(columns, cells, { empty: '지울 파일도 남긴 파일도 없습니다.' })}
${r.log ? html`<p>제거 기록: <code>${r.log}</code></p>` : ''}
${otherTable(rel, others)}`;
}

// 결과 페이지에 꽂을 명령별 화면.
const CLEANUP_VIEWS = {
  'find-broken': findBrokenView,
  'find-duplicates': findDuplicatesView,
  'find-low-quality': findLowQualityView,
  'remove-broken': removeView,
  'remove-duplicates': removeView,
  'remove-low-quality': removeView,
};

module.exports = { CLEANUP_VIEWS, findBrokenView, findDuplicatesView, findLowQualityView, removeView };

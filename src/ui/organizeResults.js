'use strict';

// 폴더 정리 화면(#257)의 결과 표. flatten·collapse·normalize·product-number의 결과 객체(미리보기·실행 모두)를
// 요약 카드와 표로 바꾼다. 실패와 건너뜀을 위에 두고, 바뀌는 이름에서 붙거나 바뀐 부분(접두어, 제품번호)을 <mark>로 강조한다.
// 결과 객체는 작업 프로세스에서 JSON으로 건너온 값(#253 serialize)이어도 된다. 화면 코드라 파일을 읽거나 바꾸지 않는다.

const path = require('node:path');
const { html } = require('./html');
const { summaryCards, table, badge } = require('./layout');

// 타겟 기준 상대경로. 타겟 자신이면 '.'.
function relativeTo(target, p) {
  return path.relative(target, p) || '.';
}

// 앞뒤가 같은 부분은 그대로, 가운데 바뀐 부분만 <mark>로 감싼 새 이름. 글자(코드 포인트) 단위로 비교해 한글·이모지가 쪼개지지 않는다.
// video.mp4 → Show CD1 video.mp4는 'Show CD1 '이, abc.mp4 → ABC-123 abc.mp4는 'ABC-123 '이 강조된다.
function highlightChange(oldName, newName) {
  const a = [...String(oldName)];
  const b = [...String(newName)];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const head = b.slice(0, start).join('');
  const middle = b.slice(start, b.length - end).join('');
  const tail = b.slice(b.length - end).join('');
  return middle === '' ? html`${newName}` : html`${head}<mark>${middle}</mark>${tail}`;
}

// 실패·건너뜀 표(공통). items: [{ path, reason }]
function reasonTable(target, items, label = '경로') {
  return table([{ label, width: '45%' }, { label: '사유' }], items.map((item) => [relativeTo(target, item.path ?? item.from), item.reason]));
}

// 바뀌는 이름 표. rows: [{ from, name, notes? }]. 원본 경로와 새 이름(바뀐 부분 강조)을 나란히 보여 준다.
function renameTable(target, rows, { status = 'moved' } = {}) {
  return table([{ label: '원본 경로', width: '45%' }, { label: '새 이름' }], rows.map((row) => [
    relativeTo(target, row.from),
    html`${highlightChange(path.basename(row.from), row.name)}${(row.notes ?? []).map((note) => html` ${badge(note.status ?? status, note.text)}`)}`,
  ]));
}

// 섹션 하나(제목 + 표). 항목이 없으면 빼서 화면을 짧게 한다. always면 비어도 보인다.
function section(title, count, content, { always = false } = {}) {
  if (count === 0 && !always) return '';
  return html`<h2>${title} <span class="muted">(${count})</span></h2>${content}`;
}

// 미리보기 표시
function previewNote(result) {
  return result.dryRun ? html`<p>${badge('warning', '미리보기')} 아직 아무것도 바뀌지 않았습니다.</p>` : '';
}

function flattenView(result) {
  const t = result.target;
  const moves = result.moved.map((move) => ({
    from: move.from,
    name: move.name,
    notes: [move.fromFolder && { text: '폴더명 사용', status: 'done' }, move.numbered && { text: '번호 붙임', status: 'warning' }].filter(Boolean),
  }));
  return html`${previewNote(result)}${summaryCards([
    { label: '이동', value: result.moved.length, tone: 'ok' },
    { label: '그대로', value: result.stay.length },
    { label: '건너뜀', value: result.skipped.length, tone: result.skipped.length > 0 ? 'warning' : undefined },
    { label: '실패', value: result.failed.length, tone: result.failed.length > 0 ? 'error' : undefined },
    { label: '빈 폴더 제거', value: result.removedFolders.length },
    { label: '남긴 폴더', value: result.keptFolders.length, tone: result.keptFolders.length > 0 ? 'warning' : undefined },
  ])}
${section('실패', result.failed.length, reasonTable(t, result.failed))}
${section('건너뜀', result.skipped.length, reasonTable(t, result.skipped))}
${section('남긴 폴더', result.keptFolders.length, reasonTable(t, result.keptFolders, '폴더'))}
${section('이동', result.moved.length, renameTable(t, moves), { always: true })}
${section('빈 폴더를 휴지통으로', result.removedFolders.length, table([{ label: '폴더' }], result.removedFolders.map((folder) => [relativeTo(t, folder)])))}`;
}

function collapseView(result) {
  const t = result.target;
  const rows = result.collapsed.map((item) => [relativeTo(t, item.leaf), relativeTo(t, item.dest)]);
  return html`${previewNote(result)}${summaryCards([
    { label: '접기', value: result.collapsed.length, tone: 'ok' },
    { label: '건너뜀', value: result.skipped.length, tone: result.skipped.length > 0 ? 'warning' : undefined },
    { label: '실패', value: result.failed.length, tone: result.failed.length > 0 ? 'error' : undefined },
  ])}
${section('실패', result.failed.length, reasonTable(t, result.failed))}
${section('건너뜀', result.skipped.length, reasonTable(t, result.skipped))}
${section('접기', result.collapsed.length, table([{ label: '안쪽 폴더', width: '50%' }, { label: '새 위치' }], rows), { always: true })}`;
}

function normalizeView(result) {
  const t = result.target;
  return html`${previewNote(result)}${summaryCards([
    { label: '이름 변경', value: result.renamed.length, tone: 'ok' },
    { label: '소문자 말', value: result.inferred.length },
    { label: '겹침', value: result.conflicts.length, tone: result.conflicts.length > 0 ? 'warning' : undefined },
    { label: '건너뜀', value: result.skipped.length, tone: result.skipped.length > 0 ? 'warning' : undefined },
    { label: '실패', value: result.failed.length, tone: result.failed.length > 0 ? 'error' : undefined },
  ])}
${section('실패', result.failed.length, reasonTable(t, result.failed))}
${section('이름이 겹침', result.conflicts.length, table([{ label: '경로', width: '35%' }, { label: '바꿀 이름', width: '30%' }, { label: '사유' }], result.conflicts.map((item) => [relativeTo(t, item.path), highlightChange(path.basename(item.path), item.name), item.reason])))}
${section('건너뜀', result.skipped.length, reasonTable(t, result.skipped))}
${section('이름 변경', result.renamed.length, renameTable(t, result.renamed), { always: true })}
${section('소문자 말이라 그대로 둠', result.inferred.length, renameTable(t, result.inferred.map((item) => ({ from: item.path, name: item.name }))))}`;
}

const SOURCE_NAMES = { title: '제목', comment: '코멘트', folder: '폴더명' };

function productNumberView(result) {
  const t = result.target;
  const renamed = result.renamed.map((item) => ({
    from: item.from,
    name: item.name,
    notes: [{ text: `${SOURCE_NAMES[item.source] ?? item.source}에서 찾음`, status: 'done' }, item.note && { text: `메타데이터를 읽지 못함: ${item.note}`, status: 'warning' }].filter(Boolean),
  }));
  return html`${previewNote(result)}${summaryCards([
    { label: '이름 변경', value: result.renamed.length, tone: 'ok' },
    { label: '이미 있음', value: result.already.length },
    { label: '못 찾음', value: result.notFound.length },
    { label: '엇갈림', value: result.conflicts.length, tone: result.conflicts.length > 0 ? 'warning' : undefined },
    { label: '건너뜀', value: result.skipped.length, tone: result.skipped.length > 0 ? 'warning' : undefined },
    { label: '실패', value: result.failed.length, tone: result.failed.length > 0 ? 'error' : undefined },
  ])}
${section('실패', result.failed.length, reasonTable(t, result.failed))}
${section('번호가 엇갈림', result.conflicts.length, table([{ label: '경로', width: '45%' }, { label: '번호' }], result.conflicts.map((item) => [relativeTo(t, item.path), html`${item.numbers.join(', ')}${item.note ? html` ${badge('warning', `메타데이터를 읽지 못함: ${item.note}`)}` : ''}`])))}
${section('건너뜀', result.skipped.length, reasonTable(t, result.skipped))}
${section('이름 변경', result.renamed.length, renameTable(t, renamed), { always: true })}
${section('이미 있음', result.already.length, table([{ label: '경로', width: '60%' }, { label: '번호' }], result.already.map((item) => [relativeTo(t, item.path), item.number])))}
${section('못 찾음', result.notFound.length, table([{ label: '경로', width: '60%' }, { label: '메모' }], result.notFound.map((item) => [relativeTo(t, item.path), item.note ?? ''])))}`;
}

// 명령 이름으로 결과 화면 본문을 만든다.
const VIEWS = { flatten: flattenView, collapse: collapseView, normalize: normalizeView, 'product-number': productNumberView };
function organizeResultView(command, result) {
  const view = VIEWS[command];
  if (!view) throw new Error(`폴더 정리 명령이 아닙니다: ${command}`);
  return view(result);
}

module.exports = { highlightChange, organizeResultView, ORGANIZE_COMMANDS: Object.keys(VIEWS) };

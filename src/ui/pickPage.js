'use strict';

// 폴더 고르기 화면(#254). GET /pick?dir=폴더&return=돌아갈 화면&field=채울 입력칸
// - dir가 없으면 드라이브와 자주 쓰는 위치(다운로드·바탕화면·문서)를 보여 준다.
// - dir가 있으면 그 폴더의 하위 폴더를 링크로 보여 주고, 위로 가기와 "이 폴더 고르기"를 둔다.
// - 고르면 return 화면으로 돌아가며 field=고른 경로를 주소에 붙인다. 화면은 그 값을 입력칸에 채운다.
// - 보호 폴더(C:\Windows, Program Files, 사용자 폴더 자체, AppData·.ssh 등)는 들어가 볼 수는 있지만 고를 수 없고 사유를 보여 준다(CLAUDE.md 규칙 4).
// 파일을 바꾸지 않는 화면이라 GET으로 답하고 토큰을 쓰지 않는다.

const { FcError, formatSize } = require('../commands');
const { html } = require('./html');
const { page, table, badge, summaryCards } = require('./layout');
const { listDrives, commonPlaces, browseFolder } = require('./folders');

const PICK_PATH = '/pick';

// 돌아갈 화면 주소는 이 서버 안의 경로만 받는다(/organize 등). //evil.example 같은 다른 사이트 주소로 보내지 않는다.
const RETURN_PATH = /^\/(?!\/)[A-Za-z0-9/_-]*$/;
// 채울 입력칸 이름
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

// 고르기 화면의 주소. dir가 없으면 처음(드라이브) 화면이다.
function pickUrl({ dir, returnTo, field }) {
  const params = new URLSearchParams();
  if (dir) params.set('dir', dir);
  if (returnTo) params.set('return', returnTo);
  if (field) params.set('field', field);
  const query = params.toString();
  return query ? `${PICK_PATH}?${query}` : PICK_PATH;
}

// 고른 뒤 돌아갈 주소. return 화면에 field=경로를 붙인다.
function chosenUrl({ returnTo, field, dir }) {
  return `${returnTo}?${new URLSearchParams({ [field]: dir })}`;
}

// 다른 화면의 폼에 넣는 경로 입력칸과 "폴더 고르기" 링크. value가 있으면 그 폴더에서 고르기를 시작한다.
function pathInput({ name = 'target', label = 'Target folder', value = '', returnTo }) {
  if (!FIELD_NAME.test(name)) throw new Error(`Not an input field name: ${name}`);
  if (!RETURN_PATH.test(returnTo)) throw new Error(`Not a return page address: ${returnTo}`);
  const link = pickUrl({ dir: value || undefined, returnTo, field: name });
  return html`<p><label>${label}<br><input type="text" name="${name}" value="${value}" size="60" spellcheck="false"></label> <a href="${link}">Choose folder</a></p>`;
}

// 요청 주소에서 고르기 값(dir, return, field)을 읽는다. 틀린 return·field는 버린다(고르기 링크 없이 둘러보기만 한다).
function readPickQuery(url) {
  const params = new URL(url, 'http://127.0.0.1').searchParams;
  const returnTo = params.get('return');
  const field = params.get('field');
  const valid = returnTo !== null && field !== null && RETURN_PATH.test(returnTo) && FIELD_NAME.test(field);
  return { dir: params.get('dir') || null, returnTo: valid ? returnTo : null, field: valid ? field : null };
}

// 처음 화면: 자주 쓰는 위치와 드라이브.
function startBody(query, { drives, places }) {
  const link = (dir) => html`<a href="${pickUrl({ ...query, dir })}">${dir}</a>`;
  return html`<h2>Common places</h2>
${table([{ label: 'Place', width: '25%' }, { label: 'Path' }], places.map((place) => [place.label, link(place.path)]), { empty: 'No places found.' })}
<h2>Drives</h2>
${table([{ label: 'Drive' }], drives.map((drive) => [link(drive)]), { empty: 'No drives found.' })}`;
}

// 폴더 화면: 위치, 위로 가기, 고르기, 하위 폴더 목록.
function folderBody(query, folder) {
  const link = (dir, text = dir) => html`<a href="${pickUrl({ ...query, dir })}">${text}</a>`;
  const up = folder.parent === null ? link(undefined, 'Drive list') : link(folder.parent, 'Up');
  const canReturn = query.returnTo !== null;
  const choose = folder.protected !== null
    ? html`<p>${badge('warning', 'Cannot choose')} This folder cannot be chosen (reason: ${folder.protected}). Choose another folder inside it.</p>`
    : canReturn
      ? html`<p><a href="${chosenUrl({ ...query, dir: folder.path })}"><strong>Choose this folder</strong></a></p>`
      : '';
  const rows = folder.folders.map((child) => [
    link(child.path, child.name),
    child.protected === null ? (canReturn ? html`<a href="${chosenUrl({ ...query, dir: child.path })}">Choose</a>` : '') : html`${badge('warning', 'Cannot choose')} <span class="muted">${child.protected}</span>`,
  ]);
  return html`<p><code>${folder.path}</code></p>
<p>${up}</p>
${choose}
${summaryCards([{ label: 'Folders', value: folder.folders.length + (folder.hiddenFolders ?? 0) }, { label: 'Files', value: folder.files }, { label: 'File size', value: formatSize(folder.size) }])}
${table([{ label: 'Folder', width: '60%' }, { label: '' }], rows, { empty: 'No subfolders.' })}
${folder.hiddenFolders > 0 ? html`<p class="muted">Too many folders, so only the first ${folder.folders.length} are shown (${folder.hiddenFolders} more).</p>` : ''}`;
}

// GET /pick 처리기. sources는 시험에서 드라이브·위치·폴더 읽기를 바꿔 끼운다.
function pickPage(req, { available }, sources = { listDrives, commonPlaces, browseFolder }) {
  const query = readPickQuery(req.url);
  const alerts = [];
  if (query.returnTo === null) alerts.push({ kind: 'info', message: 'Browsing only. If you open this from "Choose folder" on another page, the chosen folder is filled in there.' });
  // 폴더 열기는 이 화면에서 누른 링크로만 받는다. 다른 사이트의 링크·이미지가 폴더를 열게 하지 않는다(1차 리뷰).
  const site = req.headers['sec-fetch-site'];
  if (query.dir !== null && (site === 'cross-site' || site === 'same-site')) {
    alerts.push({ kind: 'error', message: 'The address was opened from another site, so the folder was not opened. Choose again below.' });
    query.dir = null;
  }
  if (query.dir !== null) {
    try {
      const folder = sources.browseFolder(query.dir);
      return { body: page({ title: 'Choose folder', available, alerts, body: folderBody(query, folder) }) };
    } catch (err) {
      if (!(err instanceof FcError)) throw err;
      alerts.push({ kind: 'error', message: err.message });
    }
  }
  return { body: page({ title: 'Choose folder', available, alerts, body: startBody(query, { drives: sources.listDrives(), places: sources.commonPlaces() }) }) };
}

// 서버에 더할 주소
function pickRoutes(sources) {
  return new Map([[PICK_PATH, (req, context) => pickPage(req, context, sources)]]);
}

module.exports = { PICK_PATH, pickUrl, chosenUrl, pathInput, readPickQuery, pickPage, pickRoutes };

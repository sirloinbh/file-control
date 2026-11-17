'use strict';

// The folder picker screen (#254). GET /pick?dir=<folder>&return=<screen to return to>&field=<input field to fill>
// - If there is no dir, it shows the drives and the frequently used places (Downloads, Desktop, Documents).
// - If there is a dir, it shows that folder's subfolders as links and puts go-up and "Choose this folder".
// - On picking, it returns to the return screen and attaches field=<picked path> to the address. The screen fills that value into the input field.
// - Protected folders (C:\Windows, Program Files, the user folder itself, AppData, .ssh, and so on) can be looked into but cannot be picked, and the reason is shown (CLAUDE.md rule 4).
// It is a screen that does not change files, so it answers with GET and does not use a token.

const { FcError, formatSize } = require('../commands');
const { html } = require('./html');
const { page, table, badge, summaryCards } = require('./layout');
const { listDrives, commonPlaces, browseFolder } = require('./folders');

const PICK_PATH = '/pick';

// For the screen to return to, it accepts only paths inside this server (/organize and so on). It does not send to another site's address such as //evil.example.
const RETURN_PATH = /^\/(?!\/)[A-Za-z0-9/_-]*$/;
// The name of the input field to fill
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

// The address of the picker screen. If there is no dir, it is the first (drives) screen.
function pickUrl({ dir, returnTo, field }) {
  const params = new URLSearchParams();
  if (dir) params.set('dir', dir);
  if (returnTo) params.set('return', returnTo);
  if (field) params.set('field', field);
  const query = params.toString();
  return query ? `${PICK_PATH}?${query}` : PICK_PATH;
}

// The address to return to after picking. It attaches field=<path> to the return screen.
function chosenUrl({ returnTo, field, dir }) {
  return `${returnTo}?${new URLSearchParams({ [field]: dir })}`;
}

// The path input field put into the forms of other screens and the "Choose folder" link. If value exists, picking starts from that folder.
function pathInput({ name = 'target', label = 'Target folder', value = '', returnTo }) {
  if (!FIELD_NAME.test(name)) throw new Error(`Not an input field name: ${name}`);
  if (!RETURN_PATH.test(returnTo)) throw new Error(`Not a return page address: ${returnTo}`);
  const link = pickUrl({ dir: value || undefined, returnTo, field: name });
  return html`<p><label>${label}<br><input type="text" name="${name}" value="${value}" size="60" spellcheck="false"></label> <a href="${link}">Choose folder</a></p>`;
}

// It reads the picker values (dir, return, field) from the request address. A wrong return or field is discarded (it only browses, with no pick link).
function readPickQuery(url) {
  const params = new URL(url, 'http://127.0.0.1').searchParams;
  const returnTo = params.get('return');
  const field = params.get('field');
  const valid = returnTo !== null && field !== null && RETURN_PATH.test(returnTo) && FIELD_NAME.test(field);
  return { dir: params.get('dir') || null, returnTo: valid ? returnTo : null, field: valid ? field : null };
}

// First screen: the frequently used places and the drives.
function startBody(query, { drives, places }) {
  const link = (dir) => html`<a href="${pickUrl({ ...query, dir })}">${dir}</a>`;
  return html`<h2>Common places</h2>
${table([{ label: 'Place', width: '25%' }, { label: 'Path' }], places.map((place) => [place.label, link(place.path)]), { empty: 'No places found.' })}
<h2>Drives</h2>
${table([{ label: 'Drive' }], drives.map((drive) => [link(drive)]), { empty: 'No drives found.' })}`;
}

// Folder screen: the location, go up, pick, and the subfolder list.
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

// The GET /pick handler. sources swaps in the drive, location, and folder reading in tests.
function pickPage(req, { available }, sources = { listDrives, commonPlaces, browseFolder }) {
  const query = readPickQuery(req.url);
  const alerts = [];
  if (query.returnTo === null) alerts.push({ kind: 'info', message: 'Browsing only. If you open this from "Choose folder" on another page, the chosen folder is filled in there.' });
  // Opening a folder is accepted only through links pressed on this screen. Links and images on other sites cannot make it open a folder (first review).
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

// The address to add to the server
function pickRoutes(sources) {
  return new Map([[PICK_PATH, (req, context) => pickPage(req, context, sources)]]);
}

module.exports = { PICK_PATH, pickUrl, chosenUrl, pathInput, readPickQuery, pickPage, pickRoutes };

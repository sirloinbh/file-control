'use strict';

// Junctions and symbolic links in list, fctl ls, and the folder picker (#267).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The temporary folder is under the AppData of the real user folder, so the user folder is swapped with a fake folder inside it.
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fc-links-')));
test.after(() => fs.rmSync(base, { recursive: true, force: true }));
const home = path.join(base, 'home');
fs.mkdirSync(home);
test.mock.method(os, 'homedir', () => home);

const { list } = require('../src/commands');
const { execute } = require('../src/execute');
const { startUi } = require('./uiClient');
const { pickRoutes } = require('../src/ui/pickPage');
const { browseFolder, listDrives, commonPlaces } = require('../src/ui/folders');
const { escapeHtml } = require('../src/ui/html');

// A junction needs no admin rights. A directory symbolic link may be refused (EPERM), so that case is skipped then.
function trySymlink(target, link, type) {
  try {
    fs.symlinkSync(target, link, type);
    return true;
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES') return false;
    throw err;
  }
}

// dir holds: real/ (with a file), a plain file, a folder junction, a file link (if allowed), a directory symlink (if allowed), and a broken junction.
function build(name) {
  const dir = fs.mkdtempSync(path.join(base, `${name}-`));
  const real = path.join(dir, 'real');
  fs.mkdirSync(real);
  fs.writeFileSync(path.join(real, 'in.txt'), '12345');
  fs.writeFileSync(path.join(dir, 'plain.txt'), 'abc');
  fs.symlinkSync(real, path.join(dir, 'junc'), 'junction');
  const gone = path.join(dir, 'gone');
  fs.mkdirSync(gone);
  fs.symlinkSync(gone, path.join(dir, 'broken'), 'junction');
  fs.rmdirSync(gone);
  const symlink = trySymlink(real, path.join(dir, 'symdir'), 'dir');
  const fileLink = trySymlink(path.join(dir, 'plain.txt'), path.join(dir, 'filelink'), 'file');
  return { dir, real, symlink, fileLink };
}

const isWindows = process.platform === 'win32';

test('list shows a link to a folder, a link to a file, and a broken link as links, not as files (#267)', () => {
  const { dir, real, symlink, fileLink } = build('list');
  const byName = Object.fromEntries(list(dir).map((e) => [e.name, e]));
  assert.strictEqual(byName.real.type, 'dir');
  assert.strictEqual(byName['plain.txt'].type, 'file');
  assert.strictEqual(byName['plain.txt'].size, 3);
  assert.deepStrictEqual({ type: byName.junc.type, linkTo: byName.junc.linkTo, size: byName.junc.size }, { type: 'link', linkTo: 'dir', size: null });
  assert.strictEqual(path.resolve(byName.junc.target), real);
  assert.deepStrictEqual({ type: byName.broken.type, linkTo: byName.broken.linkTo, size: byName.broken.size, modified: byName.broken.modified }, { type: 'link', linkTo: 'broken', size: null, modified: null });
  if (symlink) assert.deepStrictEqual({ type: byName.symdir.type, linkTo: byName.symdir.linkTo }, { type: 'link', linkTo: 'dir' });
  if (fileLink) assert.deepStrictEqual({ type: byName.filelink.type, linkTo: byName.filelink.linkTo }, { type: 'link', linkTo: 'file' });
  // Folders and links to folders come first, then the rest, each by name.
  const names = list(dir).map((e) => e.name);
  const firstFile = names.findIndex((n) => ['plain.txt', 'broken', 'filelink'].includes(n));
  assert.ok(['real', 'junc', 'symdir'].filter((n) => names.includes(n)).every((n) => names.indexOf(n) < firstFile), names.join());
});

test('fctl ls prints links with their target and keeps the lines of files and folders unchanged (#267)', () => {
  const { dir, real } = build('ls');
  const lines = execute(['ls', dir]).report.split('\n');
  assert.ok(lines.includes(`[dir]  ${''.padStart(8)}  real`), lines.join(' | '));
  assert.ok(lines.includes(`       ${'3B'.padStart(8)}  plain.txt`), lines.join(' | '));
  const junc = lines.find((l) => /\sjunc /.test(l));
  assert.match(junc, /^\[lnk\] {12}junc -> /);
  assert.ok(junc.endsWith(`${real} (folder)`), junc);
  const broken = lines.find((l) => /\sbroken /.test(l));
  assert.match(broken, /^\[lnk\] {12}broken -> .* \(broken\)$/);
  // A link line has no size.
  assert.doesNotMatch(junc, /\d+B/);
});

test('the folder picker lists link folders as enterable folders, not counted as files, and shows broken links apart (#267)', () => {
  const { dir, real, symlink, fileLink } = build('browse');
  const folder = browseFolder(dir);
  const byName = Object.fromEntries(folder.folders.map((f) => [f.name, f]));
  assert.deepStrictEqual(Object.keys(byName).sort(), ['junc', 'real', ...(symlink ? ['symdir'] : [])].sort());
  assert.strictEqual(byName.junc.link, true);
  assert.strictEqual(byName.junc.choosePath, real);
  assert.strictEqual(byName.junc.protected, null);
  assert.strictEqual(byName.real.link, undefined);
  // Only plain.txt is a file (3 bytes). Links are not counted.
  assert.strictEqual(folder.files, 1);
  assert.strictEqual(folder.size, 3);
  assert.deepStrictEqual(folder.links.map((l) => l.name).sort(), ['broken', ...(fileLink ? ['filelink'] : [])].sort());
  assert.strictEqual(folder.links.find((l) => l.name === 'broken').linkTo, 'broken');
  // Entering the link folder opens its real path.
  const inside = browseFolder(path.join(dir, 'junc'));
  assert.strictEqual(inside.path, real);
  assert.strictEqual(inside.files, 1);
  // A broken link cannot be entered.
  assert.throws(() => browseFolder(path.join(dir, 'broken')), /Not a folder or does not exist/);
});

test('a link folder to a protected folder is shown but cannot be chosen, judged by the real path (#267)', { skip: !isWindows }, () => {
  make(home, { 'AppData/Local/': '' });
  const dir = fs.mkdtempSync(path.join(base, 'prot-'));
  fs.symlinkSync(path.join(home, 'AppData'), path.join(dir, 'applink'), 'junction');
  const [entry] = browseFolder(dir).folders;
  assert.strictEqual(entry.name, 'applink');
  assert.match(entry.protected, /user settings folder/);
});

function make(dir, items) {
  for (const name of Object.keys(items)) fs.mkdirSync(path.join(dir, name), { recursive: true });
}

test('the picker screen shows link folders as links to enter and lists the others apart (#267)', async (t) => {
  const { dir, real } = build('screen');
  const sources = { listDrives, commonPlaces, browseFolder };
  const { server, get } = await startUi({ routes: pickRoutes(sources) });
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });
  const query = new URLSearchParams({ dir, return: '/organize', field: 'target' });
  const body = await (await get(`/pick?${query}`)).text();
  const enter = (p) => new URLSearchParams({ dir: p, return: '/organize', field: 'target' });
  const junction = path.join(dir, 'junc');
  assert.ok(body.includes(`href="${escapeHtml(`/pick?${enter(junction)}`)}"`), 'the link folder is entered by its own path');
  assert.ok(body.includes(`link -> `), 'the link target is shown');
  assert.ok(body.includes(escapeHtml(`/organize?${new URLSearchParams({ target: real })}`)), 'choosing a link folder picks its real path');
  assert.match(body, /Links that cannot be entered/);
  assert.match(body, /Broken link/);
  assert.ok(!body.includes(escapeHtml(`/pick?${enter(path.join(dir, 'broken'))}`)), 'a broken link has no enter link');
});

test('a link whose target exists but cannot be read is unreadable, not broken (#267)', async (t) => {
  const { dir } = build('unreadable');
  const original = fs.statSync;
  const mocked = t.mock.method(fs, 'statSync', (p, ...rest) => {
    if (path.basename(String(p)) === 'junc') throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
    return original(p, ...rest);
  });
  const byName = Object.fromEntries(list(dir).map((e) => [e.name, e]));
  assert.strictEqual(byName.junc.linkTo, 'unreadable');
  assert.strictEqual(byName.broken.linkTo, 'broken');
  assert.match(execute(['ls', dir]).report, /junc -> .* \(unreadable\)/);
  const folder = browseFolder(dir);
  assert.strictEqual(folder.links.find((l) => l.name === 'junc').linkTo, 'unreadable');
  assert.ok(!folder.folders.some((f) => f.name === 'junc'));
  mocked.mock.restore();
  // The page is rendered from the browse result of the mocked read, served through a stub.
  const fake = { ...browseFolder(dir), links: [{ name: 'junc', linkTo: 'unreadable', target: 'x' }] };
  const { server: s2, get: get2 } = await startUi({ routes: pickRoutes({ listDrives, commonPlaces, browseFolder: () => fake }) });
  t.after(() => {
    s2.close();
    s2.closeAllConnections();
  });
  const body = await (await get2(`/pick?${new URLSearchParams({ dir })}`)).text();
  assert.match(body, /Unreadable link/);
});

test('a junction to a junction shows as a link in ls and entering it lands on the final real folder (#267)', async (t) => {
  const { dir, real } = build('chain');
  fs.symlinkSync(path.join(dir, 'junc'), path.join(dir, 'chain'), 'junction');
  const line = execute(['ls', dir]).report.split('\n').find((l) => /\schain -> /.test(l));
  assert.match(line, /^\[lnk\] {12}chain -> .*junc \(folder\)$/);
  const folder = browseFolder(dir);
  const entry = folder.folders.find((f) => f.name === 'chain');
  assert.strictEqual(entry.link, true);
  assert.strictEqual(entry.choosePath, real);
  assert.strictEqual(browseFolder(path.join(dir, 'chain')).path, real);
  const { server, get } = await startUi({ routes: pickRoutes({ listDrives, commonPlaces, browseFolder }) });
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });
  const body = await (await get(`/pick?${new URLSearchParams({ dir: path.join(dir, 'chain'), return: '/organize', field: 'target' })}`)).text();
  assert.ok(body.includes(`<code>${escapeHtml(real)}</code>`));
});

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FcError } = require('../src/commands');

// The temporary folder is under the AppData of the real user folder and looks like a protected folder, so the user folder is swapped with a fake folder inside the temporary folder.
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fc-ui-folders-')));
test.after(() => fs.rmSync(base, { recursive: true, force: true }));
const home = path.join(base, 'home');
fs.mkdirSync(home);
test.mock.method(os, 'homedir', () => home);

const { listDrives, commonPlaces, browseFolder, MAX_FOLDERS } = require('../src/ui/folders');

const isWindows = process.platform === 'win32';

// It makes folders (ending in /) and files (content) under dir.
function make(dir, items) {
  for (const [name, content] of Object.entries(items)) {
    const full = path.join(dir, name);
    if (name.endsWith('/')) fs.mkdirSync(full, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
  }
}

test('browseFolder는 폴더 먼저 이름순으로 보여 주고 파일 수·크기를 요약한다 (#254)', () => {
  const dir = fs.mkdtempSync(path.join(base, 'browse-'));
  make(dir, { 'b폴더/': '', 'a폴더/': '', 'a폴더/안.txt': '1234567', 'z.txt': 'abc', '자료 #1 😀.txt': '12345' });
  const result = browseFolder(dir);
  assert.strictEqual(result.path, dir);
  assert.strictEqual(result.parent, path.dirname(dir));
  assert.strictEqual(result.protected, null);
  assert.deepStrictEqual(result.folders, [
    { name: 'a폴더', path: path.join(dir, 'a폴더'), protected: null },
    { name: 'b폴더', path: path.join(dir, 'b폴더'), protected: null },
  ]);
  // Files inside subfolders are not counted.
  assert.strictEqual(result.files, 2);
  assert.strictEqual(result.size, 8);
  // A trailing separator and .. are normalized and seen as the same folder.
  assert.strictEqual(browseFolder(path.join(dir, 'a폴더', '..') + path.sep).path, dir);
});

test('browseFolder의 parent로 위로 가고, 드라이브 루트에서는 더 올라가지 않는다 (#254)', () => {
  const dir = fs.mkdtempSync(path.join(base, 'up-'));
  make(dir, { 'one/two/': '' });
  const inner = browseFolder(path.join(dir, 'one', 'two'));
  assert.strictEqual(inner.parent, path.join(dir, 'one'));
  assert.deepStrictEqual(browseFolder(inner.parent).folders.map((folder) => folder.name), ['two']);
  const root = path.parse(dir).root;
  assert.strictEqual(browseFolder(root).parent, null);
});

test('browseFolder는 사용자 폴더 자체와 숨김 설정 폴더를 고를 수 없게 표시한다 (#254)', () => {
  make(home, { 'AppData/': '', '.ssh/': '', '.config/': '', 'Downloads/': '', '자료/': '' });
  const result = browseFolder(home);
  assert.match(result.protected, /user folder/);
  const reasons = Object.fromEntries(result.folders.map((folder) => [folder.name, folder.protected]));
  for (const name of ['AppData', '.ssh', '.config']) assert.match(reasons[name], /user settings folder/, name);
  assert.strictEqual(reasons.Downloads, null);
  assert.strictEqual(reasons['자료'], null);
  // The inside of a protected folder can also be looked into, and what is inside it also cannot be picked.
  make(home, { 'AppData/Local/': '' });
  const inside = browseFolder(path.join(home, 'AppData'));
  assert.match(inside.protected, /user settings folder/);
  assert.match(inside.folders[0].protected, /user settings folder/);
});

test('browseFolder는 시스템 폴더(C:\\Windows)와 그것을 담은 드라이브 루트를 고를 수 없게 표시한다 (#254)', { skip: !isWindows }, () => {
  const windows = process.env.SystemRoot ?? 'C:\\Windows';
  const root = browseFolder(path.parse(windows).root);
  assert.match(root.protected, /system folder/);
  const entry = root.folders.find((folder) => folder.name.toLowerCase() === path.basename(windows).toLowerCase());
  assert.ok(entry, 'Windows 폴더가 목록에 있다');
  assert.match(entry.protected, /system folder/);
});

test('browseFolder는 절대경로가 아니거나 없는 폴더, 파일을 FcError로 거부한다 (#254)', () => {
  const dir = fs.mkdtempSync(path.join(base, 'bad-'));
  make(dir, { 'file.txt': 'x' });
  for (const bad of ['relative', '', undefined, path.join(dir, 'none'), path.join(dir, 'file.txt')]) {
    assert.throws(() => browseFolder(bad), FcError, String(bad));
  }
});

test('listDrives는 있는 드라이브 루트만 차례로 돌려준다 (#254)', () => {
  const present = new Set(['C:\\', 'D:\\', 'Z:\\']);
  assert.deepStrictEqual(listDrives({ platform: 'win32', exists: (p) => present.has(p) }), ['C:\\', 'D:\\', 'Z:\\']);
  assert.deepStrictEqual(listDrives({ platform: 'win32', exists: () => false }), []);
  assert.strictEqual(listDrives({ platform: 'linux' }).length, 1);
  if (isWindows) assert.ok(listDrives().includes(path.parse(process.cwd()).root.toUpperCase()));
});

test('commonPlaces는 실제로 있는 다운로드·바탕화면·문서 경로를 찾고, OneDrive로 옮긴 폴더를 먼저 본다 (#254)', () => {
  const h = path.join(base, 'places');
  const p = (...parts) => path.join(h, ...parts);
  const run = (dirs, env = {}, names = [], registered = {}) => commonPlaces({ home: h, env, exists: (x) => dirs.includes(x), readDir: () => names, shell: () => registered });
  // If there is no OneDrive and only the default folders, that path
  assert.deepStrictEqual(run([p('Downloads'), p('Desktop'), p('Documents')]), [
    { label: 'Downloads', path: p('Downloads') },
    { label: 'Desktop', path: p('Desktop') },
    { label: 'Documents', path: p('Documents') },
  ]);
  // For Desktop and Documents moved to OneDrive (the OneDrive folder under the user folder), it also finds the Korean names.
  assert.deepStrictEqual(run([p('Downloads'), p('Desktop'), p('OneDrive', 'Desktop'), p('OneDrive', '문서'), p('Documents')], {}, ['OneDrive', 'Music']), [
    { label: 'Downloads', path: p('Downloads') },
    { label: 'Desktop', path: p('OneDrive', 'Desktop') },
    { label: 'Documents', path: p('OneDrive', '문서') },
  ]);
  // It also looks at the company OneDrive (the environment variable, the "OneDrive - Company" folder).
  const work = path.join(base, 'elsewhere', 'OneDrive - 회사');
  assert.deepStrictEqual(run([path.join(work, '바탕 화면'), p('OneDrive - 학교', 'Documents')], { OneDriveCommercial: work }, ['OneDrive - 학교']), [
    { label: 'Desktop', path: path.join(work, '바탕 화면') },
    { label: 'Documents', path: p('OneDrive - 학교', 'Documents') },
  ]);
  // Places that do not exist are left out, and if the user folder is unknown, it is an empty list.
  assert.deepStrictEqual(run([]), []);
  assert.deepStrictEqual(commonPlaces({ home: '' }), []);
  // If Downloads exists in the real user folder (the fake home), it finds it.
  make(home, { 'Downloads/': '' });
  assert.deepStrictEqual(commonPlaces({ env: {}, shell: () => ({}) }).find((place) => place.label === 'Downloads'), { label: 'Downloads', path: path.join(home, 'Downloads') });
  // If a location registered in Windows (User Shell Folders) exists, it is used first. If that folder does not exist, it moves on to the candidates (first review).
  const registered = { desktop: p('OneDrive', 'Desktop'), documents: p('Docs elsewhere'), downloads: p('gone') };
  assert.deepStrictEqual(run([p('Downloads'), p('Desktop'), p('OneDrive', 'Desktop'), p('OneDrive', '문서'), p('Documents'), p('Docs elsewhere')], {}, ['OneDrive'], registered), [
    { label: 'Downloads', path: p('Downloads') },
    { label: 'Desktop', path: p('OneDrive', 'Desktop') },
    { label: 'Documents', path: p('Docs elsewhere') },
  ]);
});

test('browseFolder는 네트워크·장치 경로를 열지 않는다 (#254 1차 리뷰)', { skip: !isWindows }, () => {
  for (const bad of ['\\\\localhost\\C$', '\\\\?\\C:\\Windows', '\\\\.\\C:\\Windows', '//localhost/C$', '\\\\attacker\\share']) {
    assert.throws(() => browseFolder(bad), (err) => err instanceof FcError && /Network and device paths/.test(err.message), bad);
  }
});

test('browseFolder는 짧은 이름·대소문자·정션을 실제 경로로 풀어 보호 폴더를 고르지 못하게 한다 (#254 1차 리뷰)', { skip: !isWindows }, () => {
  // Even if a junction points to the user settings folder (AppData), it judges by the real path.
  make(home, { 'AppData/Local/': '' });
  const dir = fs.mkdtempSync(path.join(base, 'junction-'));
  const link = path.join(dir, 'applink');
  fs.symlinkSync(path.join(home, 'AppData'), link, 'junction');
  const viaLink = browseFolder(link);
  assert.strictEqual(viaLink.path, path.join(home, 'AppData'));
  assert.match(viaLink.protected, /user settings folder/);
  assert.match(viaLink.folders[0].protected, /user settings folder/);
  // A spelling with different case is also turned into the real name.
  assert.strictEqual(browseFolder(path.join(home, 'APPDATA')).path, path.join(home, 'AppData'));
  // 8.3 short names (only on a volume that makes them)
  const windows = process.env.SystemRoot ?? 'C:\\Windows';
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  const short = path.join(path.parse(programFiles).root, 'PROGRA~1');
  if (fs.existsSync(short)) assert.match(browseFolder(short).protected, /system folder/);
  assert.match(browseFolder(windows.toUpperCase()).protected, /system folder/);
});

test('browseFolder는 끝이 점이나 공백인 이름을 고를 수 없게 표시한다 (#254 1차 리뷰)', { skip: !isWindows }, () => {
  const dir = fs.mkdtempSync(path.join(base, 'dot-'));
  // The Win32 API removes a trailing dot, so it is made with a \\?\ prefix.
  fs.mkdirSync(`\\\\?\\${path.join(dir, 'odd.')}`);
  const listed = browseFolder(dir).folders.find((folder) => folder.name === 'odd.');
  assert.ok(listed, '끝이 점인 폴더가 목록에 있다');
  assert.match(listed.protected, /name ending with a dot or space/);
  fs.rmdirSync(`\\\\?\\${path.join(dir, 'odd.')}`);
});

test('browseFolder는 하위 폴더를 MAX_FOLDERS개까지만 보여 주고 나머지 수를 알린다 (#254 1차 리뷰)', () => {
  const dir = fs.mkdtempSync(path.join(base, 'many-'));
  for (let i = 0; i < MAX_FOLDERS + 3; i++) fs.mkdirSync(path.join(dir, `d${String(i).padStart(5, '0')}`));
  const result = browseFolder(dir);
  assert.strictEqual(result.folders.length, MAX_FOLDERS);
  assert.strictEqual(result.hiddenFolders, 3);
  assert.strictEqual(result.folders[0].name, 'd00000');
});

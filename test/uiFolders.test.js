'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FcError } = require('../src/commands');

// 임시 폴더가 실제 사용자 폴더의 AppData 아래라 보호 폴더로 보이므로, 사용자 폴더를 임시 폴더 안의 가짜 폴더로 바꿔 둔다.
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fc-ui-folders-')));
test.after(() => fs.rmSync(base, { recursive: true, force: true }));
const home = path.join(base, 'home');
fs.mkdirSync(home);
test.mock.method(os, 'homedir', () => home);

const { listDrives, commonPlaces, browseFolder, MAX_FOLDERS } = require('../src/ui/folders');

const isWindows = process.platform === 'win32';

// dir 아래에 폴더(끝이 /)와 파일(내용)을 만든다.
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
  // 하위 폴더 안의 파일은 세지 않는다.
  assert.strictEqual(result.files, 2);
  assert.strictEqual(result.size, 8);
  // 끝의 구분자·.. 은 정리해 같은 폴더로 본다.
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
  // 보호 폴더 안도 들어가 볼 수는 있고, 그 안도 고를 수 없다.
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
  // OneDrive 없이 기본 폴더만 있으면 그 경로
  assert.deepStrictEqual(run([p('Downloads'), p('Desktop'), p('Documents')]), [
    { label: 'Downloads', path: p('Downloads') },
    { label: 'Desktop', path: p('Desktop') },
    { label: 'Documents', path: p('Documents') },
  ]);
  // OneDrive(사용자 폴더 아래 OneDrive 폴더)로 옮긴 바탕화면·문서는 한국어 이름도 찾는다.
  assert.deepStrictEqual(run([p('Downloads'), p('Desktop'), p('OneDrive', 'Desktop'), p('OneDrive', '문서'), p('Documents')], {}, ['OneDrive', 'Music']), [
    { label: 'Downloads', path: p('Downloads') },
    { label: 'Desktop', path: p('OneDrive', 'Desktop') },
    { label: 'Documents', path: p('OneDrive', '문서') },
  ]);
  // 회사 OneDrive(환경 변수, OneDrive - 회사 폴더)도 본다.
  const work = path.join(base, 'elsewhere', 'OneDrive - 회사');
  assert.deepStrictEqual(run([path.join(work, '바탕 화면'), p('OneDrive - 학교', 'Documents')], { OneDriveCommercial: work }, ['OneDrive - 학교']), [
    { label: 'Desktop', path: path.join(work, '바탕 화면') },
    { label: 'Documents', path: p('OneDrive - 학교', 'Documents') },
  ]);
  // 없는 위치는 빼고, 사용자 폴더를 모르면 빈 목록이다.
  assert.deepStrictEqual(run([]), []);
  assert.deepStrictEqual(commonPlaces({ home: '' }), []);
  // 실제 사용자 폴더(가짜 home)에 Downloads가 있으면 찾는다.
  make(home, { 'Downloads/': '' });
  assert.deepStrictEqual(commonPlaces({ env: {}, shell: () => ({}) }).find((place) => place.label === 'Downloads'), { label: 'Downloads', path: path.join(home, 'Downloads') });
  // Windows에 등록된 위치(User Shell Folders)가 있으면 그것을 먼저 쓴다. 그 폴더가 없으면 후보로 넘어간다(1차 리뷰).
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
  // 정션으로 user settings folder(AppData)를 가리켜도 실제 경로로 판정한다.
  make(home, { 'AppData/Local/': '' });
  const dir = fs.mkdtempSync(path.join(base, 'junction-'));
  const link = path.join(dir, 'applink');
  fs.symlinkSync(path.join(home, 'AppData'), link, 'junction');
  const viaLink = browseFolder(link);
  assert.strictEqual(viaLink.path, path.join(home, 'AppData'));
  assert.match(viaLink.protected, /user settings folder/);
  assert.match(viaLink.folders[0].protected, /user settings folder/);
  // 대소문자가 다른 표기도 실제 이름으로 바꾼다.
  assert.strictEqual(browseFolder(path.join(home, 'APPDATA')).path, path.join(home, 'AppData'));
  // 8.3 짧은 이름(만들어 두는 볼륨에서만)
  const windows = process.env.SystemRoot ?? 'C:\\Windows';
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  const short = path.join(path.parse(programFiles).root, 'PROGRA~1');
  if (fs.existsSync(short)) assert.match(browseFolder(short).protected, /system folder/);
  assert.match(browseFolder(windows.toUpperCase()).protected, /system folder/);
});

test('browseFolder는 끝이 점이나 공백인 이름을 고를 수 없게 표시한다 (#254 1차 리뷰)', { skip: !isWindows }, () => {
  const dir = fs.mkdtempSync(path.join(base, 'dot-'));
  // Win32 API는 끝의 점을 지우므로 \\?\ 접두어로 만든다.
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

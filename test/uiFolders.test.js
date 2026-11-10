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

const { listDrives, commonPlaces, browseFolder } = require('../src/ui/folders');

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
  assert.match(result.protected, /사용자 폴더/);
  const reasons = Object.fromEntries(result.folders.map((folder) => [folder.name, folder.protected]));
  for (const name of ['AppData', '.ssh', '.config']) assert.match(reasons[name], /사용자 설정 폴더/, name);
  assert.strictEqual(reasons.Downloads, null);
  assert.strictEqual(reasons['자료'], null);
  // 보호 폴더 안도 들어가 볼 수는 있고, 그 안도 고를 수 없다.
  make(home, { 'AppData/Local/': '' });
  const inside = browseFolder(path.join(home, 'AppData'));
  assert.match(inside.protected, /사용자 설정 폴더/);
  assert.match(inside.folders[0].protected, /사용자 설정 폴더/);
});

test('browseFolder는 시스템 폴더(C:\\Windows)와 그것을 담은 드라이브 루트를 고를 수 없게 표시한다 (#254)', { skip: !isWindows }, () => {
  const windows = process.env.SystemRoot ?? 'C:\\Windows';
  const root = browseFolder(path.parse(windows).root);
  assert.match(root.protected, /시스템 폴더/);
  const entry = root.folders.find((folder) => folder.name.toLowerCase() === path.basename(windows).toLowerCase());
  assert.ok(entry, 'Windows 폴더가 목록에 있다');
  assert.match(entry.protected, /시스템 폴더/);
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
  const run = (dirs, env = {}, names = []) => commonPlaces({ home: h, env, exists: (x) => dirs.includes(x), readDir: () => names });
  // OneDrive 없이 기본 폴더만 있으면 그 경로
  assert.deepStrictEqual(run([p('Downloads'), p('Desktop'), p('Documents')]), [
    { label: '다운로드', path: p('Downloads') },
    { label: '바탕화면', path: p('Desktop') },
    { label: '문서', path: p('Documents') },
  ]);
  // OneDrive(사용자 폴더 아래 OneDrive 폴더)로 옮긴 바탕화면·문서는 한국어 이름도 찾는다.
  assert.deepStrictEqual(run([p('Downloads'), p('Desktop'), p('OneDrive', 'Desktop'), p('OneDrive', '문서'), p('Documents')], {}, ['OneDrive', 'Music']), [
    { label: '다운로드', path: p('Downloads') },
    { label: '바탕화면', path: p('OneDrive', 'Desktop') },
    { label: '문서', path: p('OneDrive', '문서') },
  ]);
  // 회사 OneDrive(환경 변수, OneDrive - 회사 폴더)도 본다.
  const work = path.join(base, 'elsewhere', 'OneDrive - 회사');
  assert.deepStrictEqual(run([path.join(work, '바탕 화면'), p('OneDrive - 학교', 'Documents')], { OneDriveCommercial: work }, ['OneDrive - 학교']), [
    { label: '바탕화면', path: path.join(work, '바탕 화면') },
    { label: '문서', path: p('OneDrive - 학교', 'Documents') },
  ]);
  // 없는 위치는 빼고, 사용자 폴더를 모르면 빈 목록이다.
  assert.deepStrictEqual(run([]), []);
  assert.deepStrictEqual(commonPlaces({ home: '' }), []);
  // 실제 사용자 폴더(가짜 home)에 Downloads가 있으면 찾는다.
  make(home, { 'Downloads/': '' });
  assert.deepStrictEqual(commonPlaces({ env: {} }).find((place) => place.label === '다운로드'), { label: '다운로드', path: path.join(home, 'Downloads') });
});

'use strict';

// The folder picker screen (#254): folder browsing, go up, protected folder marks, and passing the picked path to the original screen.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The temporary folder is under the AppData of the real user folder and looks like a protected folder, so the user folder is swapped with a fake folder inside the temporary folder.
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fc-ui-pick-')));
test.after(() => fs.rmSync(base, { recursive: true, force: true }));
const home = path.join(base, 'home');
fs.mkdirSync(home);
test.mock.method(os, 'homedir', () => home);

const { startServer, runUi } = require('../src/ui/server');
const { pickRoutes, pathInput, pickUrl, readPickQuery } = require('../src/ui/pickPage');
const { browseFolder } = require('../src/ui/folders');
const { escapeHtml } = require('../src/ui/html');

// The drives and the frequently used places are fixed, and the folder reading uses the real function.
const SOURCES = {
  listDrives: () => ['C:\\', 'D:\\'],
  commonPlaces: () => [{ label: 'Downloads', path: path.join(home, 'Downloads') }],
  browseFolder,
};

async function serve(t) {
  const { server, url } = await startServer({ port: 0, routes: pickRoutes(SOURCES) });
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });
  const get = async (query) => {
    const res = await fetch(new URL(`/pick${query}`, url));
    return { status: res.status, body: await res.text() };
  };
  return { get };
}

// It turns an address into the href value in the screen (the escaped form).
const href = (url) => `href="${escapeHtml(url)}"`;
const back = (dir) => `/organize?${new URLSearchParams({ target: dir })}`;
const returning = (dir) => pickUrl({ dir, returnTo: '/organize', field: 'target' });

test('처음 화면은 자주 쓰는 위치와 드라이브를 고르기 링크로 보여 준다 (#254)', async (t) => {
  const { get } = await serve(t);
  const res = await get('?return=/organize&field=target');
  assert.strictEqual(res.status, 200);
  for (const dir of ['C:\\', 'D:\\', path.join(home, 'Downloads')]) assert.ok(res.body.includes(href(returning(dir))), dir);
  assert.ok(res.body.includes('Downloads'));
  // If it was not opened from the picker screen, it shows a browsing guide.
  assert.doesNotMatch(res.body, /Browsing only/);
  assert.match((await get('')).body, /Browsing only/);
});

test('폴더를 열면 하위 폴더를 이름순 링크로, 요약과 위로 가기·고르기 링크를 보여 준다 (#254)', async (t) => {
  const { get } = await serve(t);
  const dir = fs.mkdtempSync(path.join(base, 'browse-'));
  fs.mkdirSync(path.join(dir, 'b 폴더'));
  fs.mkdirSync(path.join(dir, "A&'x'"));
  fs.writeFileSync(path.join(dir, 'f.txt'), '12345');
  const res = await get(`?${new URLSearchParams({ dir, return: '/organize', field: 'target' })}`);
  assert.strictEqual(res.status, 200);
  // Subfolders: an enter link and a pick link. Names are escaped.
  const first = res.body.indexOf(href(returning(path.join(dir, "A&'x'"))));
  const second = res.body.indexOf(href(returning(path.join(dir, 'b 폴더'))));
  assert.ok(first > 0 && second > first, '폴더 먼저 이름순');
  assert.ok(res.body.includes('A&amp;&#39;x&#39;'));
  assert.ok(!res.body.includes("A&'x'"));
  assert.ok(res.body.includes(href(back(path.join(dir, 'b 폴더')))));
  // "Choose this folder" (the English text of the pick link label), go up, summary
  assert.ok(res.body.includes(`${href(back(dir))}><strong>Choose this folder</strong>`));
  assert.ok(res.body.includes(`${href(returning(path.dirname(dir)))}>Up</a>`));
  assert.match(res.body, /<div class="value">2<\/div><div class="label">Folders<\/div>/);
  assert.match(res.body, /<div class="value">1<\/div><div class="label">Files<\/div>/);
  assert.match(res.body, /<div class="value">5B<\/div>/);
});

test('위로 가기를 따라 올라가면 드라이브 루트에서는 드라이브 목록으로 돌아간다 (#254)', async (t) => {
  const { get } = await serve(t);
  const dir = fs.mkdtempSync(path.join(base, 'up-'));
  fs.mkdirSync(path.join(dir, 'one', 'two'), { recursive: true });
  const inner = await get(`?${new URLSearchParams({ dir: path.join(dir, 'one', 'two'), return: '/organize', field: 'target' })}`);
  assert.ok(inner.body.includes(`${href(returning(path.join(dir, 'one')))}>Up</a>`));
  const root = path.parse(dir).root;
  const top = await get(`?${new URLSearchParams({ dir: root, return: '/organize', field: 'target' })}`);
  assert.ok(top.body.includes(`${href(pickUrl({ returnTo: '/organize', field: 'target' }))}>Drive list</a>`));
});

test('보호 폴더는 들어가 볼 수 있지만 고를 수 없고 사유를 보여 준다 (#254)', async (t) => {
  const { get } = await serve(t);
  for (const name of ['AppData', '.ssh', 'Downloads']) fs.mkdirSync(path.join(home, name), { recursive: true });
  const res = await get(`?${new URLSearchParams({ dir: home, return: '/organize', field: 'target' })}`);
  // The user folder itself cannot be picked.
  assert.match(res.body, /Cannot choose/);
  assert.ok(!res.body.includes(`${href(back(home))}>`));
  assert.match(res.body, /This folder cannot be chosen \(reason: contains user folder .*\)/);
  // AppData and .ssh have only an enter link and no pick link. Downloads can be picked.
  for (const name of ['AppData', '.ssh']) {
    assert.ok(res.body.includes(href(returning(path.join(home, name)))), name);
    assert.ok(!res.body.includes(href(back(path.join(home, name)))), name);
  }
  assert.match(res.body, /user settings folder/);
  assert.ok(res.body.includes(href(back(path.join(home, 'Downloads')))));
  const inside = await get(`?${new URLSearchParams({ dir: path.join(home, 'AppData'), return: '/organize', field: 'target' })}`);
  assert.strictEqual(inside.status, 200);
  assert.doesNotMatch(inside.body, /Choose this folder/);
});

test('C:\\Windows와 드라이브 루트는 고를 수 없게 표시한다 (#254)', { skip: process.platform !== 'win32' }, async (t) => {
  const { get } = await serve(t);
  const windows = process.env.SystemRoot ?? 'C:\\Windows';
  const root = await get(`?${new URLSearchParams({ dir: path.parse(windows).root, return: '/organize', field: 'target' })}`);
  assert.match(root.body, /system folder/);
  assert.doesNotMatch(root.body, /Choose this folder/);
  assert.ok(!root.body.includes(href(back(windows))));
});

test('틀린 돌아갈 주소·입력칸 이름은 버리고 둘러보기만 하며, 없는 폴더는 오류와 처음 화면을 보여 준다 (#254)', async (t) => {
  const { get } = await serve(t);
  const dir = fs.mkdtempSync(path.join(base, 'bad-'));
  fs.mkdirSync(path.join(dir, 'sub'));
  for (const [returnTo, field] of [['//evil.example/x', 'target'], ['http://evil.example/', 'target'], ['/organize', 'a b'], ['/organize?x=1', 'target']]) {
    const res = await get(`?${new URLSearchParams({ dir, return: returnTo, field })}`);
    assert.match(res.body, /Browsing only/, returnTo);
    assert.doesNotMatch(res.body, /Choose<\/a>|Choose this folder/, returnTo);
    assert.ok(!res.body.includes('evil.example/?'), returnTo);
  }
  const missing = await get(`?${new URLSearchParams({ dir: path.join(dir, 'none'), return: '/organize', field: 'target' })}`);
  assert.strictEqual(missing.status, 200);
  assert.match(missing.body, /Not a folder or does not exist/);
  assert.match(missing.body, /<h2>Drives<\/h2>/);
  assert.match((await get('?dir=relative')).body, /Not an absolute path/);
});

test('pathInput은 입력칸과 그 값에서 시작하는 고르기 링크를 만들고, readPickQuery는 고른 값을 읽는다 (#254)', () => {
  const out = pathInput({ name: 'target', label: 'Target folder', value: 'D:\\자료 & "x"', returnTo: '/organize' }).text;
  assert.ok(out.includes('name="target" value="D:\\자료 &amp; &quot;x&quot;"'));
  assert.ok(out.includes(href(pickUrl({ dir: 'D:\\자료 & "x"', returnTo: '/organize', field: 'target' }))));
  assert.ok(pathInput({ returnTo: '/organize' }).text.includes(href('/pick?return=%2Forganize&field=target')));
  assert.throws(() => pathInput({ name: 'a"b', returnTo: '/organize' }));
  assert.throws(() => pathInput({ returnTo: '//evil.example' }));
  assert.deepStrictEqual(readPickQuery('/pick?dir=C%3A%5C&return=%2Forganize&field=target'), { dir: 'C:\\', returnTo: '/organize', field: 'target' });
  assert.deepStrictEqual(readPickQuery('/pick'), { dir: null, returnTo: null, field: null });
});

test('fctl ui의 기본 주소에 폴더 고르기 화면이 있다 (#254)', async (t) => {
  const lines = [];
  const server = await runUi(['--no-open', '--port=0'], { out: (line) => lines.push(line) });
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });
  const url = /http:\/\/127\.0\.0\.1:\d+\//.exec(lines.join('\n'))[0];
  const res = await fetch(new URL('/pick', url));
  assert.strictEqual(res.status, 200);
  assert.match(await res.text(), /<h2>Drives<\/h2>/);
});

test('다른 사이트에서 연 주소로는 폴더를 열지 않고, 네트워크 경로도 열지 않는다 (#254 1차 리뷰)', async (t) => {
  const { server, url } = await startServer({ port: 0, routes: pickRoutes(SOURCES) });
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });
  const dir = fs.mkdtempSync(path.join(base, 'cross-'));
  fs.mkdirSync(path.join(dir, 'inner'));
  const query = `/pick?${new URLSearchParams({ dir, return: '/organize', field: 'target' })}`;
  for (const site of ['cross-site', 'same-site']) {
    const res = await fetch(new URL(query, url), { headers: { 'sec-fetch-site': site } });
    const body = await res.text();
    assert.strictEqual(res.status, 200, site);
    assert.match(body, /The address was opened from another site, so the folder was not opened/, site);
    assert.ok(!body.includes('>inner</a>'), site);
    assert.match(body, /<h2>Drives<\/h2>/, site);
  }
  // A link pressed on this screen (same-origin) is opened.
  const same = await (await fetch(new URL(query, url), { headers: { 'sec-fetch-site': 'same-origin' } })).text();
  assert.ok(same.includes('>inner</a>'));
  if (process.platform === 'win32') {
    const unc = await (await fetch(new URL(`/pick?${new URLSearchParams({ dir: '\\\\attacker\\share', return: '/organize', field: 'target' })}`, url))).text();
    assert.match(unc, /Network and device paths are not opened/);
  }
});

test('하위 폴더가 한도로 잘리면 요약 카드는 전체 폴더 수를, 아래에는 뺀 수를 보여 준다 (#254 2차 리뷰)', async (t) => {
  const many = { path: 'D:\\many', parent: 'D:\\', protected: null, folders: [{ name: 'a', path: 'D:\\many\\a', protected: null }], hiddenFolders: 4, files: 0, size: 0 };
  const { server, url } = await startServer({ port: 0, routes: pickRoutes({ ...SOURCES, browseFolder: () => many }) });
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });
  const body = await (await fetch(new URL('/pick?dir=D%3A%5Cmany&return=%2Forganize&field=target', url))).text();
  assert.match(body, /<div class="value">5<\/div><div class="label">Folders<\/div>/);
  assert.match(body, /only the first 1 are shown \(4 more\)/);
});

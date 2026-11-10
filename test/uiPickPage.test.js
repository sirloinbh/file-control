'use strict';

// 폴더 고르기 화면(#254): 폴더 탐색, 위로 가기, 보호 폴더 표시, 고른 경로를 원래 화면으로 넘기기.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 임시 폴더가 실제 사용자 폴더의 AppData 아래라 보호 폴더로 보이므로, 사용자 폴더를 임시 폴더 안의 가짜 폴더로 바꿔 둔다.
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fc-ui-pick-')));
test.after(() => fs.rmSync(base, { recursive: true, force: true }));
const home = path.join(base, 'home');
fs.mkdirSync(home);
test.mock.method(os, 'homedir', () => home);

const { startServer, runUi } = require('../src/ui/server');
const { pickRoutes, pathInput, pickUrl, readPickQuery } = require('../src/ui/pickPage');
const { browseFolder } = require('../src/ui/folders');
const { escapeHtml } = require('../src/ui/html');

// 드라이브와 자주 쓰는 위치는 정해 두고, 폴더 읽기는 실제 함수를 쓴다.
const SOURCES = {
  listDrives: () => ['C:\\', 'D:\\'],
  commonPlaces: () => [{ label: '다운로드', path: path.join(home, 'Downloads') }],
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

// 주소를 화면 속 href 값(이스케이프된 꼴)으로 바꾼다.
const href = (url) => `href="${escapeHtml(url)}"`;
const back = (dir) => `/organize?${new URLSearchParams({ target: dir })}`;
const returning = (dir) => pickUrl({ dir, returnTo: '/organize', field: 'target' });

test('처음 화면은 자주 쓰는 위치와 드라이브를 고르기 링크로 보여 준다 (#254)', async (t) => {
  const { get } = await serve(t);
  const res = await get('?return=/organize&field=target');
  assert.strictEqual(res.status, 200);
  for (const dir of ['C:\\', 'D:\\', path.join(home, 'Downloads')]) assert.ok(res.body.includes(href(returning(dir))), dir);
  assert.ok(res.body.includes('다운로드'));
  // 고르기 화면에서 연 것이 아니면 둘러보기 안내를 띄운다.
  assert.doesNotMatch(res.body, /둘러보기만 합니다/);
  assert.match((await get('')).body, /둘러보기만 합니다/);
});

test('폴더를 열면 하위 폴더를 이름순 링크로, 요약과 위로 가기·고르기 링크를 보여 준다 (#254)', async (t) => {
  const { get } = await serve(t);
  const dir = fs.mkdtempSync(path.join(base, 'browse-'));
  fs.mkdirSync(path.join(dir, 'b 폴더'));
  fs.mkdirSync(path.join(dir, "A&'x'"));
  fs.writeFileSync(path.join(dir, 'f.txt'), '12345');
  const res = await get(`?${new URLSearchParams({ dir, return: '/organize', field: 'target' })}`);
  assert.strictEqual(res.status, 200);
  // 하위 폴더: 들어가기 링크와 고르기 링크. 이름은 이스케이프한다.
  const first = res.body.indexOf(href(returning(path.join(dir, "A&'x'"))));
  const second = res.body.indexOf(href(returning(path.join(dir, 'b 폴더'))));
  assert.ok(first > 0 && second > first, '폴더 먼저 이름순');
  assert.ok(res.body.includes('A&amp;&#39;x&#39;'));
  assert.ok(!res.body.includes("A&'x'"));
  assert.ok(res.body.includes(href(back(path.join(dir, 'b 폴더')))));
  // 이 폴더 고르기, 위로 가기, 요약
  assert.ok(res.body.includes(`${href(back(dir))}><strong>이 폴더 고르기</strong>`));
  assert.ok(res.body.includes(`${href(returning(path.dirname(dir)))}>위로</a>`));
  assert.match(res.body, /<div class="value">2<\/div><div class="label">폴더<\/div>/);
  assert.match(res.body, /<div class="value">1<\/div><div class="label">파일<\/div>/);
  assert.match(res.body, /<div class="value">5B<\/div>/);
});

test('위로 가기를 따라 올라가면 드라이브 루트에서는 드라이브 목록으로 돌아간다 (#254)', async (t) => {
  const { get } = await serve(t);
  const dir = fs.mkdtempSync(path.join(base, 'up-'));
  fs.mkdirSync(path.join(dir, 'one', 'two'), { recursive: true });
  const inner = await get(`?${new URLSearchParams({ dir: path.join(dir, 'one', 'two'), return: '/organize', field: 'target' })}`);
  assert.ok(inner.body.includes(`${href(returning(path.join(dir, 'one')))}>위로</a>`));
  const root = path.parse(dir).root;
  const top = await get(`?${new URLSearchParams({ dir: root, return: '/organize', field: 'target' })}`);
  assert.ok(top.body.includes(`${href(pickUrl({ returnTo: '/organize', field: 'target' }))}>드라이브 목록</a>`));
});

test('보호 폴더는 들어가 볼 수 있지만 고를 수 없고 사유를 보여 준다 (#254)', async (t) => {
  const { get } = await serve(t);
  for (const name of ['AppData', '.ssh', 'Downloads']) fs.mkdirSync(path.join(home, name), { recursive: true });
  const res = await get(`?${new URLSearchParams({ dir: home, return: '/organize', field: 'target' })}`);
  // 사용자 폴더 자체는 고를 수 없다.
  assert.match(res.body, /고를 수 없음/);
  assert.ok(!res.body.includes(`${href(back(home))}>`));
  assert.match(res.body, /이 폴더는 고를 수 없습니다\(사유: 사용자 폴더 .*를 포함\)/);
  // AppData·.ssh는 들어가기 링크만 있고 고르기 링크가 없다. Downloads는 고를 수 있다.
  for (const name of ['AppData', '.ssh']) {
    assert.ok(res.body.includes(href(returning(path.join(home, name)))), name);
    assert.ok(!res.body.includes(href(back(path.join(home, name)))), name);
  }
  assert.match(res.body, /사용자 설정 폴더/);
  assert.ok(res.body.includes(href(back(path.join(home, 'Downloads')))));
  const inside = await get(`?${new URLSearchParams({ dir: path.join(home, 'AppData'), return: '/organize', field: 'target' })}`);
  assert.strictEqual(inside.status, 200);
  assert.doesNotMatch(inside.body, /이 폴더 고르기/);
});

test('C:\\Windows와 드라이브 루트는 고를 수 없게 표시한다 (#254)', { skip: process.platform !== 'win32' }, async (t) => {
  const { get } = await serve(t);
  const windows = process.env.SystemRoot ?? 'C:\\Windows';
  const root = await get(`?${new URLSearchParams({ dir: path.parse(windows).root, return: '/organize', field: 'target' })}`);
  assert.match(root.body, /시스템 폴더/);
  assert.doesNotMatch(root.body, /이 폴더 고르기/);
  assert.ok(!root.body.includes(href(back(windows))));
});

test('틀린 돌아갈 주소·입력칸 이름은 버리고 둘러보기만 하며, 없는 폴더는 오류와 처음 화면을 보여 준다 (#254)', async (t) => {
  const { get } = await serve(t);
  const dir = fs.mkdtempSync(path.join(base, 'bad-'));
  fs.mkdirSync(path.join(dir, 'sub'));
  for (const [returnTo, field] of [['//evil.example/x', 'target'], ['http://evil.example/', 'target'], ['/organize', 'a b'], ['/organize?x=1', 'target']]) {
    const res = await get(`?${new URLSearchParams({ dir, return: returnTo, field })}`);
    assert.match(res.body, /둘러보기만 합니다/, returnTo);
    assert.doesNotMatch(res.body, /고르기<\/a>|이 폴더 고르기/, returnTo);
    assert.ok(!res.body.includes('evil.example/?'), returnTo);
  }
  const missing = await get(`?${new URLSearchParams({ dir: path.join(dir, 'none'), return: '/organize', field: 'target' })}`);
  assert.strictEqual(missing.status, 200);
  assert.match(missing.body, /폴더가 아니거나 없습니다/);
  assert.match(missing.body, /<h2>드라이브<\/h2>/);
  assert.match((await get('?dir=relative')).body, /절대경로가 아닙니다/);
});

test('pathInput은 입력칸과 그 값에서 시작하는 고르기 링크를 만들고, readPickQuery는 고른 값을 읽는다 (#254)', () => {
  const out = pathInput({ name: 'target', label: '대상 폴더', value: 'D:\\자료 & "x"', returnTo: '/organize' }).text;
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
  assert.match(await res.text(), /<h2>드라이브<\/h2>/);
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
    assert.match(body, /다른 사이트에서 연 주소라 폴더를 열지 않았습니다/, site);
    assert.ok(!body.includes('>inner</a>'), site);
    assert.match(body, /<h2>드라이브<\/h2>/, site);
  }
  // 이 화면에서 누른 링크(same-origin)는 연다.
  const same = await (await fetch(new URL(query, url), { headers: { 'sec-fetch-site': 'same-origin' } })).text();
  assert.ok(same.includes('>inner</a>'));
  if (process.platform === 'win32') {
    const unc = await (await fetch(new URL(`/pick?${new URLSearchParams({ dir: '\\\\attacker\\share', return: '/organize', field: 'target' })}`, url))).text();
    assert.match(unc, /네트워크·장치 경로는 열지 않습니다/);
  }
});

'use strict';

// fctl ui 서버 뼈대와 공통 화면(#251).

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { escapeHtml, html, raw } = require('../src/ui/html');
const { page, alertBox, summaryCards, badge, table, CATEGORIES } = require('../src/ui/layout');
const { parseUiArgs, startServer, createHandler, DEFAULT_PORT } = require('../src/ui/server');
const { FcError } = require('../src/commands');

const FCTL = path.join(__dirname, '..', 'bin', 'fctl.js');

function request(url, { method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

// node bin/fctl.js ui를 자식 프로세스로 띄우고 출력한 주소를 기다린다.
function launch(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FCTL, 'ui', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`주소를 출력하지 않았습니다: ${out} ${err}`));
    }, 20000);
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const found = /fctl 화면: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(out);
      if (found) {
        clearTimeout(timer);
        resolve({ child, url: found[1], output: () => out });
      }
    });
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(Object.assign(new Error(`일찍 끝남(${code}): ${err}`), { code, stderr: err }));
    });
  });
}

test('escapeHtml은 <, >, &, 따옴표를 바꾸고 한글·이모지 경로는 그대로 둔다 (#251)', () => {
  assert.strictEqual(escapeHtml('<script>alert("x")</script>'), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  assert.strictEqual(escapeHtml("Tom & Jerry's"), 'Tom &amp; Jerry&#39;s');
  assert.strictEqual(escapeHtml('&amp;'), '&amp;amp;');
  assert.strictEqual(escapeHtml('C:\\영상\\한글 이모지😀\\a.mp4'), 'C:\\영상\\한글 이모지😀\\a.mp4');
  assert.strictEqual(escapeHtml(null), '');
  assert.strictEqual(escapeHtml(undefined), '');
  assert.strictEqual(escapeHtml(0), '0');
});

test('html``은 끼워 넣는 값을 이스케이프하고 html``·raw()와 그 배열은 그대로 둔다 (#251)', () => {
  const name = '"><img src=x onerror=alert(1)>';
  assert.strictEqual(html`<a title="${name}">${name}</a>`.text, '<a title="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;">&quot;&gt;&lt;img src=x onerror=alert(1)&gt;</a>');
  assert.strictEqual(html`<ul>${['<a>', '&'].map((x) => html`<li>${x}</li>`)}</ul>`.text, '<ul><li>&lt;a&gt;</li><li>&amp;</li></ul>');
  assert.strictEqual(html`${raw('<b>')}${null}${undefined}${false}${0}`.text, '<b>0');
  // 배열 안의 일반 문자열도 이스케이프한다.
  assert.strictEqual(html`${['<', '>']}`.text, '&lt;&gt;');
});

test('공통 부품: 표는 경로를 이스케이프하고 빈 표에는 안내를, 배지·카드·알림은 종류별 class를 붙인다 (#251)', () => {
  const file = 'C:\\a&b\\<한글 😀>\\"x".mp4';
  const out = table([{ label: '경로', width: '70%' }, { label: '상태' }], [[file, badge('moved')], ['b', badge('skipped')], ['c', badge('failed', '실패: 잠김')]]).text;
  assert.ok(out.includes('C:\\a&amp;b\\&lt;한글 😀&gt;\\&quot;x&quot;.mp4'));
  assert.ok(!out.includes('<한글'));
  assert.ok(out.includes('<col style="width: 70%">'));
  assert.ok(out.includes('<span class="badge badge-ok">이동</span>'));
  assert.ok(out.includes('<span class="badge badge-skip">건너뜀</span>'));
  assert.ok(out.includes('<span class="badge badge-error">실패: 잠김</span>'));
  assert.ok(table([{ label: 'a' }, { label: 'b' }], []).text.includes('<td class="empty" colspan="2">항목이 없습니다.</td>'));
  assert.ok(summaryCards([{ label: '이동', value: 3, tone: 'ok' }, { label: '<실패>', value: 0 }]).text.includes('<div class="card card-ok"><div class="value">3</div><div class="label">이동</div></div><div class="card"><div class="value">0</div><div class="label">&lt;실패&gt;</div></div>'));
  assert.strictEqual(alertBox('error', '<잠김>').text, '<div class="alert alert-error" role="alert">&lt;잠김&gt;</div>');
  assert.strictEqual(alertBox('success', '끝').text, '<div class="alert alert-success" role="status">끝</div>');
  assert.throws(() => alertBox('<x>', 'a'));
});

test('page는 제목·알림을 이스케이프하고, 어두운 화면 CSS와 서버에 있는 분류만 링크한 메뉴를 넣는다 (#251)', () => {
  const out = page({ title: '<제목>', current: '/files', available: new Set(['/', '/files']), alerts: [{ kind: 'warning', message: 'a&b' }], body: html`<p>${'<본문>'}</p>` });
  assert.ok(out.startsWith('<!doctype html>'));
  assert.ok(out.includes('<meta charset="utf-8">') && out.includes('name="viewport"'));
  assert.ok(out.includes('<title>&lt;제목&gt; - fctl</title>') && out.includes('<h1>&lt;제목&gt;</h1>'));
  assert.ok(out.includes('<div class="alert alert-warning" role="alert">a&amp;b</div>'));
  assert.ok(out.includes('<p>&lt;본문&gt;</p>'));
  assert.ok(out.includes('@media (prefers-color-scheme: dark)') && out.includes(':root {'));
  assert.ok(out.includes('<a href="/files" aria-current="page">기본 파일 작업</a>'));
  for (const category of CATEGORIES.filter((c) => c.path !== '/files')) assert.ok(out.includes(`<span title="준비 중">${category.label}</span>`), category.label);
  // 클라이언트 JS는 쓰지 않는다(#250).
  assert.ok(!/<script/i.test(out));
});

test('parseUiArgs: 기본 포트 8109, --port=0, --no-open, 잘못된 포트·모르는 인자는 거부 (#251)', () => {
  assert.strictEqual(DEFAULT_PORT, 8109);
  assert.deepStrictEqual(parseUiArgs([]), { port: 8109, open: true, help: false });
  assert.deepStrictEqual(parseUiArgs(['--port=0', '--no-open']), { port: 0, open: false, help: false });
  assert.strictEqual(parseUiArgs(['-h']).help, true);
  for (const bad of [['--port=abc'], ['--port=65536'], ['--port=-1'], ['--port='], ['--port'], ['--open'], ['C:\\']]) {
    assert.throws(() => parseUiArgs(bad), FcError, bad.join(' '));
  }
});

test('fctl ui --no-open --port=0: 127.0.0.1에서 첫 화면 200, 없는 주소 404, POST 405 (#251)', async (t) => {
  const { child, url } = await launch(['--no-open', '--port=0']);
  t.after(() => child.kill());
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  const home = await request(url);
  assert.strictEqual(home.status, 200);
  assert.strictEqual(home.headers['content-type'], 'text/html; charset=utf-8');
  assert.ok(home.body.includes('<h1>파일 컨트롤</h1>'));
  for (const category of CATEGORIES) assert.ok(home.body.includes(category.label));
  const missing = await request(new URL('/nope?<x>', url));
  assert.strictEqual(missing.status, 404);
  assert.ok(missing.body.includes('없는 주소입니다: /nope?%3Cx%3E') || missing.body.includes('없는 주소입니다: /nope?&lt;x&gt;'));
  assert.ok(!missing.body.includes('<x>'));
  const head = await request(url, { method: 'HEAD' });
  assert.strictEqual(head.status, 200);
  assert.strictEqual(head.body, '');
  const post = await request(url, { method: 'POST' });
  assert.strictEqual(post.status, 405);
  assert.strictEqual(post.headers.allow, 'GET, HEAD');
});

test('fctl ui는 포트를 이미 쓰고 있으면 다른 포트로 넘어가지 않고 실패한다 (#251)', async (t) => {
  const busy = http.createServer();
  await new Promise((resolve) => busy.listen(0, '127.0.0.1', resolve));
  t.after(() => busy.close());
  const { port } = busy.address();
  await assert.rejects(startServer({ port }), (err) => err instanceof FcError && err.message.includes(`포트 ${port}를 이미 다른 프로그램이 쓰고 있습니다`) && err.message.includes('netstat'));
  // 명령으로 띄워도 종료 코드 1과 같은 안내로 끝난다.
  await assert.rejects(launch(['--no-open', `--port=${port}`]), (err) => err.code === 1 && err.stderr.includes(`포트 ${port}를 이미 다른 프로그램이 쓰고 있습니다`));
});

test('화면 코드가 예외를 내면 500 화면을 보여 주고 서버는 계속 돈다 (#251)', async (t) => {
  const routes = new Map([['/files', () => { throw new Error('<boom>'); }]]);
  const server = http.createServer(createHandler(routes));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const failed = await request(`${base}/files`);
  assert.strictEqual(failed.status, 500);
  assert.ok(failed.body.includes('화면을 만들지 못했습니다: &lt;boom&gt;'));
  const home = await request(`${base}/`);
  assert.strictEqual(home.status, 200);
  // 등록된 분류는 메뉴와 첫 화면에서 링크가 된다.
  assert.ok(home.body.includes('<a href="/files">기본 파일 작업</a>'));
});

test('fctl ui는 다른 프로그램이 같은 포트를 모든 주소(0.0.0.0)로 듣고 있어도 실패한다 (#251 1차 리뷰)', async (t) => {
  const busy = http.createServer();
  await new Promise((resolve) => busy.listen(0, '0.0.0.0', resolve));
  t.after(() => busy.close());
  const { port } = busy.address();
  await assert.rejects(startServer({ port }), (err) => err instanceof FcError && err.message.includes(`포트 ${port}를 이미 다른 프로그램이 쓰고 있습니다`));
});

test('처리기: async와 SafeHtml 본문을 받고, 경로마다 메서드를 정하며, 비동기 예외도 500으로 답한다 (#251 1차 리뷰)', async (t) => {
  const routes = new Map([
    ['/files', async () => ({ body: html`<p>${'<a>'}</p>` })],
    ['/organize', { GET: () => ({ body: 'get' }), POST: async () => ({ status: 201, body: 'posted' }) }],
    ['/archive', async () => { throw new Error('<later>'); }],
  ]);
  const server = http.createServer(createHandler(routes));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const files = await request(`${base}/files`);
  assert.deepStrictEqual([files.status, files.body], [200, '<p>&lt;a&gt;</p>']);
  assert.deepStrictEqual([(await request(`${base}/organize`)).body, (await request(`${base}/organize`, { method: 'POST' })).status], ['get', 201]);
  const put = await request(`${base}/organize`, { method: 'PUT' });
  assert.deepStrictEqual([put.status, put.headers.allow], [405, 'GET, HEAD, POST']);
  const failed = await request(`${base}/archive`);
  assert.strictEqual(failed.status, 500);
  assert.ok(failed.body.includes('화면을 만들지 못했습니다: &lt;later&gt;'));
  assert.strictEqual((await request(`${base}/`)).status, 200);
});

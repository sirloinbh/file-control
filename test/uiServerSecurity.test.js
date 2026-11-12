'use strict';

// The request check attached to the fctl ui server (#252): a wrong Host, another Origin, no or wrong token, and an attempt to change with GET are refused and files do not change.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { html } = require('../src/ui/html');
const { startServer } = require('../src/ui/server');
const { MAX_BODY } = require('../src/ui/security');

function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    // While sending a body over the limit, the server may close the connection. If a response was received, it judges by that.
    req.on('error', (err) => (err.code === 'ECONNRESET' || err.code === 'EPIPE' ? resolve({ status: 'reset' }) : reject(err)));
    req.end(body);
  });
}

// It sends the body in several pieces without Content-Length (Transfer-Encoding: chunked).
function chunked(url, parts) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' } }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
    for (const part of parts) req.write(part);
    req.end();
  });
}

// It starts a server with one screen (/form, a form that holds the token) and a POST address that writes a file (/write).
async function serve(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-ui-security-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'written.txt');
  const routes = new Map([
    ['/form', (req, context) => ({ body: html`<form method="post" action="/write">${context.tokenField}<input name="text"></form>` })],
    ['/write', { POST: (req, context) => {
      fs.writeFileSync(target, context.form.get('text'));
      return { body: 'ok' };
    } }],
  ]);
  const { server, url } = await startServer({ port: 0, routes });
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });
  const port = server.address().port;
  const form = await request(`${url}form`);
  const token = /name="token" value="([^"]+)"/.exec(form.body)?.[1];
  assert.ok(token, '폼에 토큰이 들어 있다');
  return { url, port, token, target, form };
}

const FORM_TYPE = { 'content-type': 'application/x-www-form-urlencoded' };

test('서버는 모든 응답에 보안 헤더를 붙이고 폼마다 서버 토큰을 넣는다 (#252)', async (t) => {
  const { url, form } = await serve(t);
  for (const res of [form, await request(`${url}`), await request(`${url}none`)]) {
    assert.match(res.headers['content-security-policy'], /default-src 'none'; style-src 'unsafe-inline'/);
    assert.strictEqual(res.headers['x-frame-options'], 'DENY');
    assert.strictEqual(res.headers['referrer-policy'], 'no-referrer');
    assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
  }
});

test('서버 토큰은 시작할 때마다 다르다 (#252)', async (t) => {
  const a = await serve(t);
  const b = await serve(t);
  assert.notStrictEqual(a.token, b.token);
});

test('잘못된 Host는 화면 요청과 바꾸는 요청 모두 거부하고 파일을 바꾸지 않는다 (#252)', async (t) => {
  const { url, port, token, target } = await serve(t);
  for (const host of [`evil.example:${port}`, `127.0.0.1:${port + 1}`, '127.0.0.1']) {
    assert.strictEqual((await request(`${url}form`, { headers: { host } })).status, 403, host);
    const res = await request(`${url}write`, { method: 'POST', headers: { ...FORM_TYPE, host }, body: `token=${token}&text=x` });
    assert.strictEqual(res.status, 403, host);
  }
  // A request that came in under the localhost name is accepted.
  assert.strictEqual((await request(`${url}form`, { headers: { host: `localhost:${port}` } })).status, 200);
  assert.strictEqual(fs.existsSync(target), false);
});

test('다른 Origin·다른 사이트에서 보낸 POST, 토큰 없음·틀림은 거부하고 파일을 바꾸지 않는다 (#252)', async (t) => {
  const { url, port, token, target } = await serve(t);
  const post = (headers, body) => request(`${url}write`, { method: 'POST', headers: { ...FORM_TYPE, ...headers }, body });
  for (const origin of ['https://evil.example', 'null', `http://localhost:${port + 1}`]) {
    const res = await post({ origin }, `token=${token}&text=x`);
    assert.strictEqual(res.status, 403, origin);
    assert.match(res.body, /Requests sent from another site/);
  }
  assert.strictEqual((await post({ 'sec-fetch-site': 'cross-site' }, `token=${token}&text=x`)).status, 403);
  const missing = await post({ origin: url.slice(0, -1) }, 'text=x');
  assert.strictEqual(missing.status, 403);
  assert.match(missing.body, /Reopen the page/);
  assert.strictEqual((await post({}, 'token=wrong&text=x')).status, 403);
  assert.strictEqual((await post({}, `token=${token.slice(1)}&text=x`)).status, 403);
  // A body that is not a form type or exceeds the limit is also refused.
  assert.strictEqual((await post({ 'content-type': 'text/plain' }, `token=${token}&text=x`)).status, 415);
  assert.strictEqual((await post({}, `token=${token}&text=${'x'.repeat(MAX_BODY)}`)).status, 413);
  // Even if sent in chunks (chunked) without Content-Length, it is blocked by the limit while reading (first review).
  assert.strictEqual((await chunked(`${url}write`, [`token=${token}&text=`, 'x'.repeat(MAX_BODY / 2), 'x'.repeat(MAX_BODY / 2)])).status, 413);
  // A mark that it was sent from another port on the same PC (same-site), and a duplicated token field, are also refused.
  assert.strictEqual((await post({ 'sec-fetch-site': 'same-site' }, `token=${token}&text=x`)).status, 403);
  assert.strictEqual((await post({}, `token=${token}&token=${token}x&text=x`)).status, 403);
  assert.strictEqual(fs.existsSync(target), false);
});

test('GET으로 바꾸기를 시도하면 405로 거부하고 파일을 바꾸지 않는다 (#252)', async (t) => {
  const { url, token, target } = await serve(t);
  for (const method of ['GET', 'HEAD']) {
    const res = await request(`${url}write?token=${token}&text=x`, { method });
    assert.strictEqual(res.status, 405, method);
  }
  assert.strictEqual(fs.existsSync(target), false);
});

test('같은 주소에서 토큰과 함께 보낸 POST만 처리기를 부른다 (#252)', async (t) => {
  const { url, token, target } = await serve(t);
  const res = await request(`${url}write`, { method: 'POST', headers: { ...FORM_TYPE, origin: url.slice(0, -1), 'sec-fetch-site': 'same-origin' }, body: `token=${encodeURIComponent(token)}&text=${encodeURIComponent('한글 <ok>')}` });
  assert.deepStrictEqual([res.status, res.body], [200, 'ok']);
  assert.strictEqual(fs.readFileSync(target, 'utf8'), '한글 <ok>');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Readable } = require('node:stream');
const security = require('../src/ui/security');

const { MAX_BODY, SECURITY_HEADERS, RequestError, createToken, isAllowedHost, isAllowedOrigin, checkRequest, isValidToken, checkToken, readBody, readForm, tokenField } = security;

const PORT = 8109;

// 이 서버로 보낸 정상 POST 헤더. 테스트마다 일부를 바꿔 쓴다.
function postHeaders(extra = {}) {
  return { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, 'content-type': 'application/x-www-form-urlencoded', ...extra };
}

// 본문을 담은 가짜 요청(읽기 스트림 + method·headers).
function fakeRequest(body, { method = 'POST', headers = postHeaders() } = {}) {
  const req = Readable.from(body === '' ? [] : [Buffer.from(body)]);
  req.method = method;
  req.headers = headers;
  return req;
}

// fn이 RequestError(status)를 던지는지 본다.
function assertRejects(fn, status) {
  assert.throws(fn, (err) => err instanceof RequestError && err.status === status && typeof err.message === 'string' && err.message !== '');
}

test('createToken은 매번 다른 256비트 base64url 토큰을 만든다 (#252)', () => {
  const a = createToken();
  const b = createToken();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notStrictEqual(a, b);
});

test('isAllowedHost는 127.0.0.1·localhost와 서버 포트만 받는다 (#252)', () => {
  for (const host of [`127.0.0.1:${PORT}`, `localhost:${PORT}`, `LOCALHOST:${PORT}`, ` localhost:${PORT} `]) assert.strictEqual(isAllowedHost(host, PORT), true, host);
  // DNS 재바인딩(다른 이름), 포트 없음·다른 포트, IPv6·0.0.0.0, 빈 값은 거부한다.
  for (const host of [`evil.example:${PORT}`, `127.0.0.1.evil.example:${PORT}`, '127.0.0.1', 'localhost', `127.0.0.1:${PORT + 1}`, `[::1]:${PORT}`, `0.0.0.0:${PORT}`, `127.0.0.2:${PORT}`, '', undefined, ['127.0.0.1:8109']]) {
    assert.strictEqual(isAllowedHost(host, PORT), false, String(host));
  }
  // 아직 포트를 모르면(0) 아무것도 받지 않는다.
  assert.strictEqual(isAllowedHost('127.0.0.1:0', 0), false);
});

test('isAllowedOrigin은 없거나 같은 주소일 때만 받는다 (#252)', () => {
  assert.strictEqual(isAllowedOrigin(undefined, PORT), true);
  for (const origin of [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]) assert.strictEqual(isAllowedOrigin(origin, PORT), true, origin);
  for (const origin of ['null', '', 'https://evil.example', `http://evil.example:${PORT}`, `https://127.0.0.1:${PORT}`, `http://127.0.0.1:${PORT + 1}`, `http://127.0.0.1:${PORT}/x`, `http://127.0.0.1`]) {
    assert.strictEqual(isAllowedOrigin(origin, PORT), false, origin);
  }
});

test('checkRequest는 화면 요청은 Host만 보고, 바꾸는 요청은 POST·Origin·형식·크기까지 본다 (#252)', () => {
  // 화면(GET)은 Host만 맞으면 된다.
  checkRequest({ method: 'GET', headers: { host: `localhost:${PORT}` } }, { port: PORT });
  assertRejects(() => checkRequest({ method: 'GET', headers: { host: `evil.example:${PORT}` } }, { port: PORT }), 403);
  // 바꾸는 요청: 정상 POST는 통과하고, Origin이 없는 POST도 받는다.
  checkRequest({ method: 'POST', headers: postHeaders() }, { port: PORT, mutating: true });
  checkRequest({ method: 'POST', headers: postHeaders({ origin: undefined }) }, { port: PORT, mutating: true });
  checkRequest({ method: 'POST', headers: postHeaders({ 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' }) }, { port: PORT, mutating: true });
  // GET 등으로 바꾸기 시도는 405
  for (const method of ['GET', 'HEAD', 'PUT', 'DELETE']) assertRejects(() => checkRequest({ method, headers: postHeaders() }, { port: PORT, mutating: true }), 405);
  // 잘못된 Host는 메서드보다 먼저 거부한다.
  assertRejects(() => checkRequest({ method: 'GET', headers: { host: `evil.example:${PORT}` } }, { port: PORT, mutating: true }), 403);
  // 다른 Origin, 다른 사이트에서 왔다는 Sec-Fetch-Site
  assertRejects(() => checkRequest({ method: 'POST', headers: postHeaders({ origin: 'https://evil.example' }) }, { port: PORT, mutating: true }), 403);
  assertRejects(() => checkRequest({ method: 'POST', headers: postHeaders({ origin: 'null' }) }, { port: PORT, mutating: true }), 403);
  for (const site of ['cross-site', 'same-site']) assertRejects(() => checkRequest({ method: 'POST', headers: postHeaders({ origin: undefined, 'sec-fetch-site': site }) }, { port: PORT, mutating: true }), 403);
  // 폼 형식이 아니면 415, 선언한 길이가 한도를 넘으면 413
  for (const type of [undefined, 'text/plain', 'multipart/form-data; boundary=x', 'application/json']) {
    assertRejects(() => checkRequest({ method: 'POST', headers: postHeaders({ 'content-type': type }) }, { port: PORT, mutating: true }), 415);
  }
  assertRejects(() => checkRequest({ method: 'POST', headers: postHeaders({ 'content-length': String(MAX_BODY + 1) }) }, { port: PORT, mutating: true }), 413);
});

test('isValidToken과 checkToken은 정확히 같은 토큰 하나만 받는다 (#252)', () => {
  const token = createToken();
  assert.strictEqual(isValidToken(token, token), true);
  for (const given of [undefined, '', token.slice(1), `${token}x`, token.toUpperCase() === token ? `${token.slice(0, -1)}a` : token.toUpperCase()]) {
    assert.strictEqual(isValidToken(given, token), false, String(given));
  }
  // 서버 토큰이 비어 있으면 아무것도 받지 않는다.
  assert.strictEqual(isValidToken('', ''), false);
  checkToken(new URLSearchParams({ token }), token);
  assertRejects(() => checkToken(new URLSearchParams(), token), 403);
  assertRejects(() => checkToken(new URLSearchParams({ token: 'wrong' }), token), 403);
  // 같은 이름이 둘이면(하나는 맞아도) 거부한다.
  assertRejects(() => checkToken(new URLSearchParams([['token', token], ['token', 'x']]), token), 403);
});

test('readBody는 한도까지만 읽고 넘으면 413으로 거부한다 (#252)', async () => {
  assert.strictEqual(await readBody(fakeRequest('a=1&b=%ED%95%9C')), 'a=1&b=%ED%95%9C');
  assert.strictEqual(await readBody(fakeRequest('')), '');
  assert.strictEqual(await readBody(fakeRequest('x'.repeat(10)), 10), 'x'.repeat(10));
  await assert.rejects(readBody(fakeRequest('x'.repeat(11)), 10), (err) => err instanceof RequestError && err.status === 413);
  // 여러 조각으로 와도 합계로 본다. Content-Length 없이 보내도 막힌다.
  const chunks = Readable.from([Buffer.alloc(MAX_BODY), Buffer.from('y')]);
  await assert.rejects(readBody(chunks), (err) => err instanceof RequestError && err.status === 413);
});

test('readForm은 헤더·본문·토큰을 모두 통과해야 폼 값을 돌려준다 (#252)', async () => {
  const token = createToken();
  const form = await readForm(fakeRequest(`token=${token}&path=${encodeURIComponent('D:\\자료 <1>')}`), { port: PORT, token });
  assert.strictEqual(form.get('path'), 'D:\\자료 <1>');
  const rejected = async (req, status) => assert.rejects(readForm(req, { port: PORT, token }), (err) => err instanceof RequestError && err.status === status);
  await rejected(fakeRequest(`token=${token}`, { headers: postHeaders({ host: `evil.example:${PORT}` }) }), 403);
  await rejected(fakeRequest(`token=${token}`, { headers: postHeaders({ origin: 'http://evil.example' }) }), 403);
  await rejected(fakeRequest(`token=${token}`, { method: 'GET' }), 405);
  await rejected(fakeRequest('path=x'), 403);
  await rejected(fakeRequest('token=wrong&path=x'), 403);
  await rejected(fakeRequest(`token=${token}&pad=${'x'.repeat(MAX_BODY)}`), 413);
});

test('보안 헤더는 스크립트를 막고 인라인 스타일만 허용하며 프레임·리퍼러를 막는다 (#252)', () => {
  const csp = SECURITY_HEADERS['Content-Security-Policy'];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /style-src 'unsafe-inline'/);
  assert.match(csp, /form-action 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /script-src/);
  assert.strictEqual(SECURITY_HEADERS['X-Frame-Options'], 'DENY');
  assert.strictEqual(SECURITY_HEADERS['Referrer-Policy'], 'no-referrer');
  assert.strictEqual(SECURITY_HEADERS['X-Content-Type-Options'], 'nosniff');
  assert.throws(() => { SECURITY_HEADERS['X-Frame-Options'] = 'ALLOW'; });
});

test('tokenField는 숨은 토큰 필드를 만들고 토큰이 아닌 값은 거부한다 (#252)', () => {
  const token = createToken();
  assert.strictEqual(tokenField(token), `<input type="hidden" name="token" value="${token}">`);
  for (const bad of ['', '"><script>', 'a b']) assert.throws(() => tokenField(bad));
});

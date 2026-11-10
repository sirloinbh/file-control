'use strict';

// fctl ui 로컬 서버의 요청 검사(#252). 서버(#251)와 떼어 둔 순수 함수라 http 없이 시험할 수 있다.
// 이 서버는 파일을 옮기고 지우므로, 다른 웹사이트가 브라우저를 시켜 보내는 요청(CSRF)과
// DNS 재바인딩(공격자 도메인을 127.0.0.1로 바꿔 같은 출처처럼 보이게 하는 것)을 막는다.

const crypto = require('node:crypto');

// 요청 본문 한도. 폼은 경로 몇 개와 선택값뿐이라 64KiB면 넉넉하다. 넘으면 읽기를 멈추고 거부한다.
const MAX_BODY = 64 * 1024;

// 토큰 폼 필드 이름.
const TOKEN_FIELD = 'token';

// 모든 응답에 붙이는 보안 헤더. 스크립트는 어디서도 받지 않고, 스타일은 HTML 안의 것만 쓴다.
// 폼은 같은 서버로만 보내고, 다른 사이트가 이 화면을 프레임에 넣지 못하게 한다.
const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
});

// 요청을 거부할 때 던지는 오류. status는 응답 코드, message는 화면에 보일 한국어 사유다.
class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'RequestError';
    this.status = status;
  }
}

// 서버 시작 때 한 번 만드는 무작위 토큰(256비트). 폼 값과 주소에 그대로 넣을 수 있게 base64url로 만든다.
function createToken() {
  return crypto.randomBytes(32).toString('base64url');
}

// 이 서버의 주소로 쓸 수 있는 host:포트 목록. 서버는 127.0.0.1에만 연결을 받는다.
function allowedHosts(port) {
  return [`127.0.0.1:${port}`, `localhost:${port}`];
}

// Host 헤더가 이 서버 주소(127.0.0.1:포트, localhost:포트)면 true. 대소문자는 가리지 않는다.
// 다른 이름(evil.example:포트)은 DNS 재바인딩일 수 있어 거부한다. 포트가 빠지거나 다른 것도 거부한다.
function isAllowedHost(host, port) {
  if (typeof host !== 'string' || !Number.isInteger(port) || port <= 0) return false;
  return allowedHosts(port).includes(host.trim().toLowerCase());
}

// Origin 헤더가 없거나 이 서버 주소(http://127.0.0.1:포트, http://localhost:포트)면 true.
// 다른 사이트, https, 'null'(샌드박스 프레임·파일에서 보낸 폼)은 거부한다.
function isAllowedOrigin(origin, port) {
  if (origin === undefined) return true;
  if (typeof origin !== 'string') return false;
  return allowedHosts(port).some((host) => origin.trim().toLowerCase() === `http://${host}`);
}

// 상태를 바꾸지 않는 요청(GET 화면)의 검사. Host만 본다. 맞지 않으면 RequestError를 던진다.
// mutating이 true면(파일을 바꾸는 주소) POST가 아닌 요청도 거부한다. GET으로 바꾸기를 시도하는 링크·이미지를 막는다.
function checkRequest({ method, headers }, { port, mutating = false }) {
  if (!isAllowedHost(headers.host, port)) throw new RequestError(403, '이 서버 주소(127.0.0.1 또는 localhost)로 들어온 요청만 받습니다.');
  if (!mutating) return;
  if (method !== 'POST') throw new RequestError(405, '파일을 바꾸는 요청은 화면의 버튼(POST)으로만 받습니다.');
  checkPostHeaders(headers, port);
}

// POST 요청 헤더 검사. Origin이 있으면 같은 주소여야 하고, 브라우저가 다른 사이트에서 보냈다고 알리면(Sec-Fetch-Site) 거부한다.
// 폼은 application/x-www-form-urlencoded로만 받는다.
function checkPostHeaders(headers, port) {
  if (!isAllowedOrigin(headers.origin, port)) throw new RequestError(403, '다른 사이트에서 보낸 요청이라 받지 않습니다.');
  const site = headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') throw new RequestError(403, '다른 사이트에서 보낸 요청이라 받지 않습니다.');
  const type = String(headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/x-www-form-urlencoded') throw new RequestError(415, '화면의 폼으로 보낸 요청만 받습니다.');
  const length = headers['content-length'];
  if (length !== undefined && Number(length) > MAX_BODY) throw new RequestError(413, `요청이 너무 큽니다(최대 ${MAX_BODY}바이트).`);
}

// 폼 토큰이 서버 토큰과 같으면 true. 길이가 다르거나 없으면 false. 비교 시간으로 토큰을 알아내지 못하게 한다.
function isValidToken(given, token) {
  if (typeof given !== 'string' || typeof token !== 'string' || token === '') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// 폼 값(URLSearchParams)의 토큰을 확인한다. 없거나 틀리면 RequestError(403)를 던진다.
function checkToken(form, token) {
  const values = form.getAll(TOKEN_FIELD);
  if (values.length !== 1 || !isValidToken(values[0], token)) throw new RequestError(403, '화면이 오래되었거나 다른 곳에서 보낸 요청입니다. 화면을 새로 열어 다시 시도하세요.');
}

// 요청 본문을 한도까지 읽어 문자열로 돌려준다. 한도를 넘으면 더 읽지 않고 RequestError(413)로 거부한다.
// stream은 http.IncomingMessage처럼 data·end·error 이벤트를 내는 읽기 스트림이다.
function readBody(stream, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      fn(value);
    };
    stream.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        stream.pause();
        finish(reject, new RequestError(413, `요청이 너무 큽니다(최대 ${limit}바이트).`));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => finish(resolve, Buffer.concat(chunks).toString('utf8')));
    stream.on('error', (err) => finish(reject, err));
  });
}

// POST 요청 전체 검사: 헤더 검사, 본문 읽기, 토큰 확인을 거쳐 폼 값(URLSearchParams)을 돌려준다.
// 하나라도 맞지 않으면 RequestError를 던진다. 호출한 쪽은 이 함수가 끝난 뒤에만 파일을 바꾼다.
async function readForm(req, { port, token, limit = MAX_BODY }) {
  checkRequest(req, { port, mutating: true });
  const form = new URLSearchParams(await readBody(req, limit));
  checkToken(form, token);
  return form;
}

// 폼에 넣을 숨은 토큰 필드. 토큰은 base64url 글자만 있어 이스케이프가 필요 없지만, 다른 값이 오면 거부한다.
function tokenField(token) {
  if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new Error('토큰 형식이 아닙니다.');
  return `<input type="hidden" name="${TOKEN_FIELD}" value="${token}">`;
}

module.exports = {
  MAX_BODY,
  TOKEN_FIELD,
  SECURITY_HEADERS,
  RequestError,
  createToken,
  isAllowedHost,
  isAllowedOrigin,
  checkRequest,
  isValidToken,
  checkToken,
  readBody,
  readForm,
  tokenField,
};

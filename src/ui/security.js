'use strict';

// The request check of the fctl ui local server (#252). It is a pure function kept apart from the server (#251), so it can be tested without http.
// This server moves and deletes files, so it blocks requests that another website makes the browser send (CSRF) and
// DNS rebinding (making an attacker's domain resolve to 127.0.0.1 so that it looks like the same origin).

const crypto = require('node:crypto');

// The request body limit. A form has only a few paths and options, so 64KiB is plenty. If exceeded, it stops reading and refuses.
const MAX_BODY = 64 * 1024;

// The token form field name.
const TOKEN_FIELD = 'token';

// Security headers attached to every response. Scripts are not accepted from anywhere, and only styles inside the HTML are used.
// Forms are sent only to the same server, and other sites cannot put this screen in a frame.
const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'X-Frame-Options': 'DENY',
  // same-origin, not no-referrer: under no-referrer Chrome sends 'Origin: null' on a same-origin form POST,
  // which checkPostHeaders refuses, so no button would work (#299). same-origin still sends no referrer to other sites.
  'Referrer-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
});

// The error thrown when refusing a request. status is the response code and message is the reason shown on the screen.
class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'RequestError';
    this.status = status;
  }
}

// A random token (256 bits) made once at server start. It is made as base64url so it can go into a form value without escaping.
// The token goes only into POST forms. Putting it in a GET form or link address would leave it in the browser history and the address bar (first review).
function createToken() {
  return crypto.randomBytes(32).toString('base64url');
}

// The list of host:port values that can be used as this server's address. The server accepts connections only on 127.0.0.1.
function allowedHosts(port) {
  return [`127.0.0.1:${port}`, `localhost:${port}`];
}

// True if the Host header is this server's address (127.0.0.1:port, localhost:port). Case does not matter.
// Other names (evil.example:port) may be DNS rebinding, so they are refused. A missing or different port is also refused.
function isAllowedHost(host, port) {
  if (typeof host !== 'string' || !Number.isInteger(port) || port <= 0) return false;
  return allowedHosts(port).includes(host.trim().toLowerCase());
}

// True if there is no Origin header or it is this server's address (http://127.0.0.1:port, http://localhost:port).
// Another site, https, and 'null' (a form sent from a sandboxed frame or a file) are refused.
function isAllowedOrigin(origin, port) {
  if (origin === undefined) return true;
  if (typeof origin !== 'string') return false;
  return allowedHosts(port).some((host) => origin.trim().toLowerCase() === `http://${host}`);
}

// The check for requests that do not change state (GET screens). It looks only at Host. If it does not match, it throws RequestError.
// If mutating is true (an address that changes files), it also refuses requests that are not POST. This blocks links and images that try to change things with GET.
function checkRequest({ method, headers }, { port, mutating = false }) {
  if (!isAllowedHost(headers.host, port)) throw new RequestError(403, 'Only requests to this server address (127.0.0.1 or localhost) are accepted.');
  if (!mutating) return;
  if (method !== 'POST') throw new RequestError(405, 'Requests that change files are accepted only from the page buttons (POST).');
  checkPostHeaders(headers, port);
}

// The POST request header check. If Origin exists, it must be the same address, and if the browser says it was sent from another site (Sec-Fetch-Site), it refuses.
// Forms are accepted only as application/x-www-form-urlencoded.
function checkPostHeaders(headers, port) {
  if (!isAllowedOrigin(headers.origin, port)) throw new RequestError(403, 'Requests sent from another site are not accepted.');
  const site = headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') throw new RequestError(403, 'Requests sent from another site are not accepted.');
  const type = String(headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/x-www-form-urlencoded') throw new RequestError(415, 'Only requests sent from the page form are accepted.');
  const length = headers['content-length'];
  if (length !== undefined && Number(length) > MAX_BODY) throw new RequestError(413, `The request is too large (max ${MAX_BODY} bytes).`);
}

// True if the form token equals the server token. False if the length differs or it is missing. It keeps the token from being found out through the comparison time.
function isValidToken(given, token) {
  if (typeof given !== 'string' || typeof token !== 'string' || token === '') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// It checks the token in the form values (URLSearchParams). If missing or wrong, it throws RequestError (403).
function checkToken(form, token) {
  const values = form.getAll(TOKEN_FIELD);
  if (values.length !== 1 || !isValidToken(values[0], token)) throw new RequestError(403, 'The page is out of date or the request came from elsewhere. Reopen the page and try again.');
}

// A form body is tiny, so a client that has not finished sending it within this time is cut off (#328).
const BODY_TIMEOUT_MS = 10 * 1000;

// It reads the request body up to the limit and returns a string. If the limit is exceeded, it stops reading and refuses with RequestError (413),
// and it stops reading; the caller destroys the request after it has sent the refusal (destroying first would drop the response). A client that disconnects or does not finish within timeoutMs is refused too (408/400).
// stream is a read stream that emits data, end, error, close and aborted events, like http.IncomingMessage.
function readBody(stream, limit = MAX_BODY, timeoutMs = BODY_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    let timer = null;
    const finish = (fn, value, pause = false) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (pause && typeof stream.pause === 'function') stream.pause();
      fn(value);
    };
    timer = setTimeout(() => finish(reject, new RequestError(408, 'The request body was not received in time.'), true), timeoutMs);
    timer.unref?.();
    stream.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        finish(reject, new RequestError(413, `The request is too large (max ${limit} bytes).`), true);
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => finish(resolve, Buffer.concat(chunks).toString('utf8')));
    stream.on('error', (err) => finish(reject, err));
    stream.on('aborted', () => finish(reject, new RequestError(400, 'The request was closed before it was fully sent.')));
    stream.on('close', () => finish(reject, new RequestError(400, 'The request was closed before it was fully sent.')));
  });
}

// The whole POST request check: it goes through the header check, reading the body, and the token check, and returns the form values (URLSearchParams).
// If even one does not match, it throws RequestError. The caller changes files only after this function finishes.
async function readForm(req, { port, token, limit = MAX_BODY }) {
  checkRequest(req, { port, mutating: true });
  const form = new URLSearchParams(await readBody(req, limit));
  checkToken(form, token);
  return form;
}

// The hidden token field to put in a form. The token has only base64url characters, so no escaping is needed, but if another value comes, it refuses.
function tokenField(token) {
  if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new Error('Not a token format.');
  return `<input type="hidden" name="${TOKEN_FIELD}" value="${token}">`;
}

// The browser session (#265). Another process or another Windows user on this PC can reach 127.0.0.1:port, so the Host and token checks alone
// would let it read the token from GET / and then POST. Every request therefore needs a session cookie that only the browser opened
// with the one-time launch address printed in the terminal gets. The cookie is HttpOnly and SameSite=Strict.
const SESSION_COOKIE = 'fctl_session';

// path limits where the browser sends the cookie (#328): the secret path prefix of this server, so another port on 127.0.0.1 never gets it.
function sessionCookie(value, path = '/') {
  return `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=${path}`;
}

// True if the Cookie header carries the session value. Compared with timingSafeEqual. A cookie with the same name twice is accepted if any one matches.
function hasSession(cookieHeader, session) {
  if (typeof cookieHeader !== 'string') return false;
  let found = false;
  for (const part of cookieHeader.split(';')) {
    const at = part.indexOf('=');
    if (at < 0 || part.slice(0, at).trim() !== SESSION_COOKIE) continue;
    if (isValidToken(part.slice(at + 1).trim(), session)) found = true;
  }
  return found;
}

module.exports = {
  SESSION_COOKIE,
  sessionCookie,
  hasSession,
  MAX_BODY,
  BODY_TIMEOUT_MS,
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

'use strict';

// A shared helper for the UI HTTP tests (#265). The server only answers a browser that went through the launch step,
// so tests start the server with a known launch value and token, do the launch step, and then send every request with the session cookie.

const assert = require('node:assert');
const { startServer } = require('../src/ui/server');

const LAUNCH = 'test-launch-value';
const TOKEN = 'test-token-value';

// It does the launch step against launchUrl and returns get/post functions that carry the session cookie (and post carries the token).
async function connect(launchUrl, { token = TOKEN } = {}) {
  const base = new URL('/', launchUrl);
  const res = await fetch(launchUrl, { redirect: 'manual' });
  assert.strictEqual(res.status, 303, 'the launch step answers 303');
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const get = (p, init = {}) => fetch(new URL(p, base), { redirect: 'manual', ...init, headers: { cookie, ...init.headers } });
  const post = (p, fields = {}, init = {}) => get(p, {
    method: 'POST',
    body: new URLSearchParams({ token, ...fields }).toString(),
    ...init,
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...init.headers },
  });
  return { base: base.href, cookie, token, get, post };
}

// It starts a server with the fixed launch value and token, does the launch step, and returns { server, url, launchUrl, cookie, token, get, post }.
async function startUi({ port = 0, routes, token = TOKEN, launch = LAUNCH } = {}) {
  const started = await startServer({ port, routes, token, launch });
  return { ...started, ...(await connect(started.launchUrl, { token })) };
}

module.exports = { LAUNCH, TOKEN, connect, startUi };

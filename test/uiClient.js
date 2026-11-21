'use strict';

// A shared helper for the UI HTTP tests (#265). The server only answers a browser that went through the launch step,
// so tests start the server with a known launch value and token, do the launch step, and then send every request with the session cookie.

const assert = require('node:assert');
const http = require('node:http');
const { startServer, createHandler } = require('../src/ui/server');

const LAUNCH = 'test-launch-value';
const TOKEN = 'test-token-value';

// The port range the OS gives to port 0 includes ports that undici's fetch refuses (it fails with TypeError 'fetch failed' whose cause is 'bad port').
const isBadPort = (err) => err?.cause?.message === 'bad port';

// It runs attempt() and runs it again (up to tries times in all) if it failed only because fetch refused the port. attempt must close what it started when it throws.
async function withUsablePort(attempt, tries = 5) {
  for (let i = 1; ; i += 1) {
    try {
      return await attempt();
    } catch (err) {
      if (!isBadPort(err) || i >= tries) throw err;
    }
  }
}

// A request without a cookie gets 403 and changes nothing, so it only shows whether fetch accepts this port.
const probe = (url) => fetch(url, { method: 'HEAD' });

async function closeServer(server) {
  server.close();
  server.closeAllConnections();
}

// It does the launch step against launchUrl and returns get/post functions that carry the session cookie (and post carries the token).
async function connect(launchUrl, { token = TOKEN } = {}) {
  const res = await fetch(launchUrl, { redirect: 'manual' });
  assert.strictEqual(res.status, 303, 'the launch step answers 303');
  const cookie = res.headers.get('set-cookie').split(';')[0];
  // The server serves everything under a secret path prefix (#328). The helper keeps tests prefix-agnostic: requests are sent under the prefix,
  // and the prefix is removed from the response body and Location, so tests keep using plain addresses like /form.
  const base = new URL(`/${new URL(res.headers.get('location'), launchUrl).pathname.split('/')[1]}/`, launchUrl);
  const prefix = base.pathname.replace(/\/$/, '');
  const strip = async (r) => {
    const headers = new Headers(r.headers);
    const location = headers.get('location');
    if (location !== null && location.startsWith(`${prefix}/`)) headers.set('location', location.slice(prefix.length));
    const body = [101, 204, 205, 304].includes(r.status) ? null : (await r.text()).split(`${prefix}/`).join('/');
    return new Response(body, { status: r.status, statusText: r.statusText, headers });
  };
  const get = async (p, init = {}) => strip(await fetch(new URL(p.replace(/^\//, ''), base), { redirect: 'manual', ...init, headers: { cookie, ...init.headers } }));
  const post = (p, fields = {}, init = {}) => get(p, {
    method: 'POST',
    body: new URLSearchParams({ token, ...fields }).toString(),
    ...init,
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...init.headers },
  });
  return { base: base.href, cookie, token, get, post };
}

// It starts a server on a free port that fetch accepts, without doing the launch step. Returns { server, url, launchUrl }.
function startProbed({ routes, token = TOKEN, launch = LAUNCH } = {}) {
  return withUsablePort(async () => {
    const started = await startServer({ port: 0, routes, token, launch });
    try {
      await probe(started.url);
    } catch (err) {
      await closeServer(started.server);
      throw err;
    }
    return started;
  });
}

// It starts a server with the fixed launch value and token, does the launch step, and returns { server, url, launchUrl, cookie, token, get, post }.
async function startUi({ routes, token = TOKEN, launch = LAUNCH } = {}) {
  const started = await startProbed({ routes, token, launch });
  return { ...started, ...(await connect(started.launchUrl, { token })) };
}

// The same for a handler made by createHandler on a plain http server, for tests that call createHandler directly. Returns { server, get, post }.
function startHandler(routes, { token = TOKEN, launch = LAUNCH } = {}) {
  return withUsablePort(async () => {
    const server = http.createServer(createHandler(routes, { token, launch }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;
    try {
      await probe(url);
      return { server, ...(await connect(`${url}?launch=${encodeURIComponent(launch)}`, { token })) };
    } catch (err) {
      await closeServer(server);
      throw err;
    }
  });
}

module.exports = { LAUNCH, TOKEN, isBadPort, withUsablePort, probe, connect, startProbed, startUi, startHandler };

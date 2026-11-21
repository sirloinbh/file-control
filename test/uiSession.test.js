'use strict';

// The browser session of the fctl ui server (#265): without the cookie from the one-time launch address, nothing is served.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { html } = require('../src/ui/html');
const { hasSession, sessionCookie, createToken } = require('../src/ui/security');
const { LAUNCH, TOKEN, connect, startProbed, startUi } = require('./uiClient');

const FORM = { 'content-type': 'application/x-www-form-urlencoded' };

async function serve(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-ui-session-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'written.txt');
  const routes = new Map([
    ['/form', (req, context) => ({ body: html`<form method="post" action="/write">${context.tokenField}</form>` })],
    ['/job', () => ({ body: 'job status' })],
    ['/write', { POST: () => {
      fs.writeFileSync(target, 'x');
      return { body: 'ok' };
    } }],
  ]);
  const started = await startProbed({ routes });
  t.after(() => {
    started.server.close();
    started.server.closeAllConnections();
  });
  return { ...started, target };
}

const noToken = async (res) => {
  const body = await res.text();
  assert.ok(!body.includes(TOKEN), 'the body has no token');
  assert.ok(!body.includes('name="token"'), 'the body has no token field');
  return body;
};

test('without the cookie, GET and POST are refused with 403 and no token or file data in the body', async (t) => {
  const { url, target } = await serve(t);
  for (const p of ['', 'form', 'job', 'pick', 'nope']) {
    const res = await fetch(new URL(p, url), { redirect: 'manual' });
    assert.strictEqual(res.status, 403, p);
    assert.strictEqual(res.headers.get('set-cookie'), null);
    assert.match(await noToken(res), /Open the address printed in the terminal/);
  }
  const post = await fetch(new URL('write', url), { method: 'POST', headers: FORM, body: `token=${TOKEN}` });
  assert.strictEqual(post.status, 403);
  await noToken(post);
  assert.strictEqual(fs.existsSync(target), false);
});

test('a wrong or malformed cookie is refused', async (t) => {
  const { url, target } = await serve(t);
  const { cookie } = await connect((await serve(t)).launchUrl);
  const value = cookie.split('=')[1];
  // The cookie of another server, an empty one, a different name, and a value that is a prefix of the real one.
  for (const bad of [cookie, 'fctl_session=', 'fctl_session', `other=${value}`, 'fctl_session=wrong', `fctl_session=${value.slice(1)}`, `fctl_session=${LAUNCH}`]) {
    const get = await fetch(new URL('form', url), { headers: { cookie: bad } });
    assert.strictEqual(get.status, 403, bad);
    await noToken(get);
    assert.strictEqual((await fetch(new URL('write', url), { method: 'POST', headers: { ...FORM, cookie: bad }, body: `token=${TOKEN}` })).status, 403, bad);
  }
  assert.strictEqual(fs.existsSync(target), false);
});

test('HEAD without a cookie on a non-launch path is 403 with an empty body', async (t) => {
  const { url } = await serve(t);
  for (const p of ['', 'form', 'nope']) {
    const res = await fetch(new URL(p, url), { method: 'HEAD', redirect: 'manual' });
    assert.strictEqual(res.status, 403, p);
    assert.strictEqual(await res.text(), '');
  }
});

test('a wrong launch value gets no cookie and does not use up the real one', async (t) => {
  const { url, launchUrl } = await serve(t);
  for (const query of ['?launch=wrong', '?launch=', `?launch=${LAUNCH}x`, `?launch=${LAUNCH}&launch=${LAUNCH}`]) {
    const res = await fetch(new URL(query, url), { redirect: 'manual' });
    assert.strictEqual(res.status, 403, query);
    assert.strictEqual(res.headers.get('set-cookie'), null, query);
  }
  assert.strictEqual((await fetch(launchUrl, { redirect: 'manual' })).status, 303);
});

test('the launch value gives the cookie once, redirects without the query, and works only once', async (t) => {
  const { url, launchUrl } = await serve(t);
  const first = await fetch(new URL(`form?launch=${LAUNCH}&keep=1`, url), { redirect: 'manual' });
  assert.strictEqual(first.status, 303);
  const prefix = new URL(url).pathname.replace(/\/$/, '');
  assert.strictEqual(first.headers.get('location'), `${prefix}/form?keep=1`);
  const setCookie = first.headers.get('set-cookie');
  assert.match(setCookie, /^fctl_session=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/[A-Za-z0-9_-]{43}\/$/);
  const cookie = setCookie.split(';')[0];
  // The cookie opens the page the redirect points at.
  const page = await fetch(new URL('form?keep=1', url), { headers: { cookie } });
  assert.strictEqual(page.status, 200);
  assert.ok((await page.text()).includes(`name="token" value="${TOKEN}"`));
  // The same address again is used up: a second browser gets nothing.
  const second = await fetch(launchUrl, { redirect: 'manual' });
  assert.strictEqual(second.status, 403);
  assert.strictEqual(second.headers.get('set-cookie'), null);
  assert.strictEqual((await fetch(new URL('form', url))).status, 403);
  // The first browser keeps working.
  assert.strictEqual((await fetch(new URL('form', url), { headers: { cookie } })).status, 200);
});

test('the launch step is for GET only, and the redirect can never leave this server', async (t) => {
  const { launchUrl } = await serve(t);
  const post = await fetch(launchUrl, { method: 'POST', headers: FORM, body: `token=${TOKEN}`, redirect: 'manual' });
  assert.strictEqual(post.status, 403);
  const head = await fetch(launchUrl, { method: 'HEAD', redirect: 'manual' });
  assert.strictEqual(head.status, 403);
  // A path that normalizes to a leading double slash would be a protocol-relative Location, so the slashes are collapsed.
  const { port } = new URL(launchUrl);
  const location = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: `/.//evil.example/p?launch=${LAUNCH}` }, (res) => {
      res.resume();
      resolve(res.headers.location);
    }).on('error', reject);
  });
  assert.match(location, /^\/[A-Za-z0-9_-]{43}\/evil\.example\/p$/);
});

test('with the cookie but no token, a POST is still refused and nothing changes', async (t) => {
  const { launchUrl, target } = await serve(t);
  const { post, get } = await connect(launchUrl);
  const noTokenPost = await get('/write', { method: 'POST', headers: FORM, body: 'text=x' });
  assert.strictEqual(noTokenPost.status, 403);
  assert.match(await noTokenPost.text(), /Reopen the page/);
  assert.strictEqual(fs.existsSync(target), false);
  assert.strictEqual((await post('/write')).status, 200);
  assert.strictEqual(fs.existsSync(target), true);
});

test('every restart makes a new launch value and session', async (t) => {
  const a = await startUi({ routes: new Map(), token: createToken(), launch: createToken() });
  const b = await startUi({ routes: new Map(), token: createToken(), launch: createToken() });
  t.after(() => {
    for (const s of [a, b]) {
      s.server.close();
      s.server.closeAllConnections();
    }
  });
  assert.notStrictEqual(new URL(a.launchUrl).searchParams.get('launch'), new URL(b.launchUrl).searchParams.get('launch'));
  assert.match(a.launchUrl, /^http:\/\/127\.0\.0\.1:\d+\/\?launch=[A-Za-z0-9_-]{43}$/);
  // An old address from a stopped server does not work on a new one.
  assert.strictEqual((await fetch(b.url, { headers: { cookie: a.cookie } })).status, 403);
  assert.strictEqual((await b.get('/')).status, 200);
});

test('hasSession compares the cookie value exactly and ignores other cookies', () => {
  assert.strictEqual(hasSession(`a=1; ${sessionCookie('abc').split(';')[0]}; b=2`, 'abc'), true);
  assert.strictEqual(hasSession('fctl_session=abcd', 'abc'), false);
  assert.strictEqual(hasSession('fctl_session=ab', 'abc'), false);
  assert.strictEqual(hasSession(undefined, 'abc'), false);
  assert.strictEqual(hasSession('fctl_session=', ''), false);
});

test('the cookie alone is not enough: without the secret path prefix a request is refused and the cookie is limited to that path (#328)', async (t) => {
  const { launchUrl, url, target } = await serve(t);
  const res = await fetch(launchUrl, { redirect: 'manual' });
  const setCookie = res.headers.get('set-cookie');
  const prefix = new URL(url).pathname.replace(/\/$/, '');
  assert.ok(setCookie.endsWith(`; Path=${prefix}/`), 'the cookie is sent only under the secret prefix');
  const cookie = setCookie.split(';')[0];
  // What another local service that got the cookie could try: the same cookie on addresses without the prefix, GET and POST.
  const origin = new URL(url).origin;
  for (const p of ['/', '/form', '/job', '/write']) {
    assert.strictEqual((await fetch(`${origin}${p}`, { headers: { cookie }, redirect: 'manual' })).status, 403, p);
  }
  const post = await fetch(`${origin}/write`, { method: 'POST', headers: { ...FORM, cookie }, body: `token=${TOKEN}` });
  assert.strictEqual(post.status, 403);
  // A wrong prefix is refused too, even with the cookie and the token.
  const wrong = await fetch(`${origin}/${createToken()}/write`, { method: 'POST', headers: { ...FORM, cookie }, body: `token=${TOKEN}` });
  assert.strictEqual(wrong.status, 403);
  assert.strictEqual(fs.existsSync(target), false);
  // With the prefix, the cookie and the token it works, and the links the server writes carry the prefix.
  const page = await fetch(new URL('form', url), { headers: { cookie } });
  assert.strictEqual(page.status, 200);
  const text = await page.text();
  assert.ok(text.includes(`action="${prefix}/write"`), text.slice(text.indexOf("<form"), text.indexOf("<form") + 200));
  assert.strictEqual((await fetch(new URL('write', url), { method: 'POST', headers: { ...FORM, cookie }, body: `token=${TOKEN}` })).status, 200);
  assert.strictEqual(fs.existsSync(target), true);
});

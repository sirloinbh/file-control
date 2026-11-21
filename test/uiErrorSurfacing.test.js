'use strict';

// Programming errors are shown with their real cause and never hide a valid preview (#318).
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { startHandler } = require('./uiClient');
const { resultPage } = require('../src/ui/jobPages');
const { toPlain, MAX_DEPTH } = require('../src/ui/serialize');
const { grant } = require('../src/access');
const { html } = require('../src/ui/html');

const FP = 'a'.repeat(64);
const preview = (extra = {}) => ({
  id: 'p', argv: ['rm', 'D:/a'], mode: 'preview', status: 'done', startedAt: 0, endedAt: 1, lines: [], droppedLines: 0, error: null,
  outcome: { command: 'rm', report: 'would delete', fingerprint: FP },
  ...extra,
});
const clock = { elapsed: () => 1, running: () => null };

test('a result view that throws a TypeError falls back to the report, keeps the Run form, shows the message and logs the stack', (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const spec = { command: 'rm', path: '/files/rm', title: 'Delete', fields: [], toArgv: () => ['rm'] };
  const body = String(resultPage(clock, preview(), {
    specs: [spec],
    tokenField: html`<input type="hidden" name="token" value="t">`,
    views: { rm() { return null.boom; } },
  }));
  assert.match(body, /Could not build the result view: Cannot read properties of null/);
  assert.match(body, /<pre class="report">would delete<\/pre>/);
  assert.match(body, /name="fingerprint" value="a{64}"/, 'the Run form stays');
  assert.ok(logged.mock.calls.some((call) => String(call.arguments[0]).includes('TypeError')), 'the stack is logged');
});

test('a 500 from screen code logs the stack to the console and shows the message on the page', async (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const { server, get } = await startHandler(new Map([['/bug', () => { undefined.x; }]]));
  t.after(() => server.close());
  const res = await get('/bug');
  assert.strictEqual(res.status, 500);
  assert.match(await res.text(), /Could not build the page: Cannot read properties of undefined/);
  assert.ok(logged.mock.calls.some((call) => /TypeError[\s\S]*at /.test(String(call.arguments[0]))));
});

test('toPlain cuts a very deep or very large value instead of overflowing the stack', () => {
  let deep = { end: true };
  for (let i = 0; i < 10000; i++) deep = { next: deep };
  const plain = toPlain(deep);
  let node = plain;
  let depth = 0;
  while (node && typeof node === 'object') { node = node.next; depth += 1; }
  assert.strictEqual(node, '[too deep]');
  assert.ok(depth <= MAX_DEPTH + 1);
  const wide = toPlain(Array.from({ length: 250000 }, () => ({})));
  assert.ok(wide.includes('[too large]'));
  assert.deepStrictEqual(toPlain({ a: [1, { b: new Set([2]) }] }), { a: [1, { b: [2] }] });
});

test('grant shows the message of a programming error instead of "undefined"', (t) => {
  const os = require('node:os');
  const fs = require('node:fs');
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fc-318-')));
  const dir = path.join(base, 'work');
  fs.mkdirSync(dir);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  t.mock.method(os, 'homedir', () => path.join(base, 'home'));
  const access = grant(dir, ['delete']);
  // The delete check reads the path with lstatSync; a bug there is a TypeError, which has no code.
  t.mock.method(fs, 'lstatSync', () => { throw new TypeError('injected bug'); });
  assert.throws(() => access.delete(path.join(dir, 'x')), (err) => err.message.includes('Cannot check the path') && err.message.endsWith('(injected bug)'));
});

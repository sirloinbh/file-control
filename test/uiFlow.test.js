'use strict';

// Decision part of the shared preview -> run flow (#255).

const test = require('node:test');
const assert = require('node:assert');
const { canonical, fingerprint, checkRunRequest, decideExecution, dangerConfirmations, orderResults, countResults, resultSection } = require('../src/ui/flow');

const preview = { target: 'C:\\t', dryRun: true, moved: [{ from: 'C:\\t\\a\\x.mp4', to: 'C:\\t\\x.mp4' }], skipped: [] };
const base = { command: 'flatten', args: ['C:\\t'], options: {}, preview };

test('canonical turns key order, Set, Map, Error, and bigint into the same JSON value every time (#255)', () => {
  assert.deepStrictEqual(canonical({ b: 1, a: new Set(['y', 'x']), c: new Map([['k', 1n]]), e: new Error('locked'), u: undefined }), { a: ['x', 'y'], b: 1, c: { k: '1' }, e: { error: 'locked' } });
  assert.strictEqual(JSON.stringify(canonical({ b: 1, a: 2 })), JSON.stringify(canonical({ a: 2, b: 1 })));
});

test('fingerprint is the same when command, args, options, and preview are the same, and differs if any one differs (#255)', () => {
  const same = fingerprint(base);
  assert.match(same, /^[0-9a-f]{64}$/);
  assert.strictEqual(fingerprint({ ...base, preview: JSON.parse(JSON.stringify(preview)) }), same);
  assert.notStrictEqual(fingerprint({ ...base, args: ['C:\\u'] }), same);
  assert.notStrictEqual(fingerprint({ ...base, options: { force: true } }), same);
  assert.notStrictEqual(fingerprint({ ...base, command: 'collapse' }), same);
  assert.notStrictEqual(fingerprint({ ...base, preview: { ...preview, moved: [] } }), same);
  // Values that change every time can be left out of the comparison.
  assert.strictEqual(fingerprint({ ...base, preview: { ...preview, elapsed: 1 } }, { volatile: ['elapsed'] }), fingerprint({ ...base, preview: { ...preview, elapsed: 2 } }, { volatile: ['elapsed'] }));
});

test('decideExecution: a request that did not come from a preview is not run (#255)', () => {
  const fresh = fingerprint(base);
  for (const form of [{}, { fingerprint: '' }, { fingerprint: 'abc' }, { fingerprint: fresh.toUpperCase() }, { fingerprint: ['x'] }]) {
    const decision = decideExecution(form, fresh);
    assert.strictEqual(decision.action, 'reject', JSON.stringify(form));
    assert.match(decision.reason, /did not come from a preview/);
  }
});

test('decideExecution: a different fingerprint (folder changed after the preview) gives a new preview, the same one runs (#255)', () => {
  const old = fingerprint(base);
  const fresh = fingerprint({ ...base, preview: { ...preview, moved: [] } });
  assert.deepStrictEqual(decideExecution({ fingerprint: old }, fresh), { action: 'repreview', reason: 'The folder changed after the preview, so nothing was run. Check the new preview and run it again.' });
  assert.deepStrictEqual(decideExecution({ fingerprint: old }, old), { action: 'execute' });
});

test('decideExecution: overwrite or permanent delete turned on without the extra confirmation is not run (#255)', () => {
  const fresh = fingerprint(base);
  for (const name of ['force', 'permanent']) {
    for (const confirm of [undefined, '', 'no', 'on']) {
      const decision = decideExecution({ fingerprint: fresh, [name]: 'on', [`confirm-${name}`]: confirm }, fresh);
      assert.strictEqual(decision.action, 'reject', `${name} ${confirm}`);
      assert.match(decision.reason, /not confirmed again/);
    }
    assert.strictEqual(decideExecution({ fingerprint: fresh, [name]: 'on', [`confirm-${name}`]: 'yes' }, fresh).action, 'execute');
  }
  // Without the confirmation, the request is rejected first even if the fingerprint differs (a dangerous option is not passed on to a new preview).
  assert.strictEqual(decideExecution({ fingerprint: fresh, permanent: 'on' }, fingerprint({ ...base, command: 'x' })).action, 'reject');
});

test('dangerConfirmations: only options that are on get a warning and a required confirmation box (#255)', () => {
  assert.deepStrictEqual(dangerConfirmations({}), []);
  const out = dangerConfirmations({ permanent: 'on' }).map(String).join('');
  assert.ok(out.includes('name="confirm-permanent" value="yes" required'));
  assert.ok(out.includes('Files are deleted permanently without going to the Recycle Bin'));
  assert.ok(!out.includes('confirm-force'));
});

test('results: failed and skipped come first, and the summary cards show moved, skipped, and failed counts with reasons (#255)', () => {
  const items = [
    { status: 'moved', path: 'C:\\t\\a.mp4' },
    { status: 'failed', path: 'C:\\t\\<b>.mp4', reason: 'in use & locked' },
    { status: 'moved', path: 'C:\\t\\c.mp4' },
    { status: 'skipped', path: 'C:\\t\\d.mp4', reason: 'same name exists' },
  ];
  assert.deepStrictEqual(orderResults(items).map((item) => item.path), ['C:\\t\\<b>.mp4', 'C:\\t\\d.mp4', 'C:\\t\\a.mp4', 'C:\\t\\c.mp4']);
  assert.deepStrictEqual(countResults(items), { done: 2, skipped: 1, failed: 1 });
  const out = String(resultSection(items, { doneLabel: 'Sent to Recycle Bin' }));
  assert.ok(out.includes('<div class="card card-ok"><div class="value">2</div><div class="label">Sent to Recycle Bin</div></div>'));
  assert.ok(out.includes('<div class="card card-error"><div class="value">1</div><div class="label">Failed</div></div>'));
  assert.ok(out.includes('C:\\t\\&lt;b&gt;.mp4') && out.includes('in use &amp; locked'));
  assert.ok(out.indexOf('&lt;b&gt;') < out.indexOf('d.mp4') && out.indexOf('d.mp4') < out.indexOf('a.mp4'));
});

test('checkRunRequest: a request without a valid fingerprint is rejected (#255)', () => {
  const fresh = fingerprint(base);
  for (const form of [{}, { fingerprint: '' }, { fingerprint: 'abc' }, { fingerprint: 'g'.repeat(64) }, { fingerprint: fresh.toUpperCase() }, { fingerprint: [fresh] }, { fingerprint: 5 }, { fingerprint: null }]) {
    const checked = checkRunRequest(form);
    assert.strictEqual(checked.action, 'reject', JSON.stringify(form));
    assert.match(checked.reason, /did not come from a preview/);
  }
});

test('checkRunRequest: force or permanent without the confirmation is rejected (#255)', () => {
  const fresh = fingerprint(base);
  for (const name of ['force', 'permanent']) {
    for (const confirm of [undefined, '', 'no', 'on', ['yes']]) {
      const checked = checkRunRequest({ fingerprint: fresh, [name]: 'on', [`confirm-${name}`]: confirm });
      assert.strictEqual(checked.action, 'reject', `${name} ${confirm}`);
      assert.match(checked.reason, /not confirmed again/);
    }
    assert.deepStrictEqual(checkRunRequest({ fingerprint: fresh, [name]: 'on', [`confirm-${name}`]: 'yes' }), { action: 'ok' });
  }
  assert.strictEqual(checkRunRequest({ fingerprint: fresh, force: ['on'] }).action, 'ok');
});

test('checkRunRequest: a valid fingerprint with no dangerous option is ok (#255)', () => {
  assert.deepStrictEqual(checkRunRequest({ fingerprint: fingerprint(base) }), { action: 'ok' });
});

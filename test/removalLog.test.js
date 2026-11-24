'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FcError } = require('../src/commands');
const journal = require('../src/journal');
const { writeRemovalLog, updateRemovalLog, REMOVAL_LOG } = require('../src/removalLog');
const { logs, readRecord } = require('./removalRecord');

// The temporary folder is under the AppData of the real user folder and is refused as a protected path, so the user folder is swapped with a fake path.
test.mock.method(os, 'homedir', () => path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home'));

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-log-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync.native(dir);
}

function make(dir, files) {
  for (const [file, content] of Object.entries(files)) {
    const full = path.join(dir, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

const now = new Date(2026, 10, 1, 9, 5, 7);

// The removal record is a part of a journal run (#415), so the calls run inside one.
function inRun(dir, fn) {
  const run = journal.begin('remove-test', [], { base: dir });
  try {
    return fn();
  } finally {
    journal.finish(run);
  }
}

test('대상이 없으면 파일을 만들지 않고 null을 돌려준다', () => {
  const dir = tempDir();
  assert.strictEqual(writeRemovalLog(dir, 'duplicates', [], { now }), null);
  assert.deepStrictEqual(logs(dir), []);
});

test('대상 하나라도 기록할 수 없으면 아무것도 남기지 않는다', () => {
  const dir = tempDir();
  const outside = tempDir();
  make(dir, { 'a.mp4': 'x', 'folder/b.mp4': 'y' });
  make(outside, { 'o.mp4': 'z' });
  fs.symlinkSync(outside, path.join(dir, 'link'), 'junction');
  const cases = [
    [{ path: 'none.mp4', reason: 'r' }, /does not exist or is a broken link/],
    [{ path: 'folder', reason: 'r' }, /because it is not a file/],
    [{ path: 'link', reason: 'r' }, /Cannot delete a link/],
    [{ path: 'link/o.mp4', reason: 'r' }, /outside the target folder/],
    [{ path: path.join(outside, 'o.mp4'), reason: 'r' }, /outside the target folder/],
    [{ path: 'a.mp4' }, /No removal reason/],
    [{ path: 'a.mp4', reason: '' }, /No removal reason/],
    [{ path: 'a.mp4', reason: '   ' }, /No removal reason/],
    [{ reason: 'r' }, /path to record is invalid/],
    [null, /path to record is invalid/],
    [{ path: 1n, reason: 'r' }, /path to record is invalid/],
  ];
  for (const [bad, message] of cases) {
    assert.throws(() => writeRemovalLog(dir, 'duplicates', [{ path: 'a.mp4', reason: 'r' }, bad], { now }), (err) => err instanceof FcError && message.test(err.message));
  }
  assert.deepStrictEqual(logs(dir), []);
});

test('빈 칸이 있는 목록은 건너뛰지 않고 거부한다', () => {
  const dir = tempDir();
  make(dir, { 'a.mp4': 'x' });
  const items = [{ path: 'a.mp4', reason: 'r' }, , { path: 'a.mp4', reason: 'r' }]; // eslint-disable-line no-sparse-arrays
  assert.throws(() => writeRemovalLog(dir, 'duplicates', items, { now }), (err) => err instanceof FcError && /path to record is invalid/.test(err.message));
  assert.deepStrictEqual(logs(dir), []);
});

test('같은 파일이 두 번 있으면 표기가 달라도 거부한다', () => {
  const dir = tempDir();
  make(dir, { 'a.mp4': 'x' });
  assert.throws(() => writeRemovalLog(dir, 'duplicates', [{ path: 'a.mp4', reason: 'r' }, { path: path.join(dir, 'a.mp4'), reason: 'r' }], { now }), /same file appears twice/);
  assert.deepStrictEqual(logs(dir), []);
});

test('종류와 목록이 잘못되면 거부한다', () => {
  const dir = tempDir();
  assert.throws(() => writeRemovalLog(dir, '', []), /removal kind/);
  assert.throws(() => writeRemovalLog(dir, undefined, []), /removal kind/);
  assert.throws(() => writeRemovalLog(dir, '   ', []), /removal kind/);
  assert.throws(() => writeRemovalLog(dir, 'duplicates', 'a.mp4'), /must be a list/);
  assert.throws(() => writeRemovalLog(dir, 'duplicates', [], { now: new Date(NaN) }), /record time/);
  assert.throws(() => writeRemovalLog(dir, 'duplicates', [], { now: 'today' }), /record time/);
});

test('보호 경로는 거부한다', () => {
  assert.throws(() => writeRemovalLog(process.env.SystemRoot ?? 'C:\\Windows', 'duplicates', []), FcError);
});


test('the record goes into the change journal with path, size and reason, and the files stay', () => {
  const dir = tempDir();
  make(dir, { 'a/깨진.mp4': '12345', 'b.mkv': '' });
  const result = inRun(dir, () => writeRemovalLog(dir, 'broken files', [{ path: 'a/깨진.mp4', reason: '헤더 불일치' }, { path: path.join(dir, 'b.mkv'), reason: '크기 0' }], { now }));
  assert.match(path.basename(result.path), /^fctl-journal-.*\.jsonl$/);
  assert.strictEqual(result.count, 2);
  const log = readRecord(result.path);
  assert.deepStrictEqual(result.items, log.items);
  assert.strictEqual(log.kind, 'broken files');
  assert.match(log.createdAt, /^2026-11-01T09:05:07[+-]\d{2}:\d{2}$/);
  assert.strictEqual(log.target, dir);
  assert.strictEqual(log.version, 1);
  assert.deepStrictEqual(log.items, [
    { path: path.join(dir, 'a', '깨진.mp4'), size: 5, reason: '헤더 불일치', outcome: 'pending' },
    { path: path.join(dir, 'b.mkv'), size: 0, reason: '크기 0', outcome: 'pending' },
  ]);
  assert.ok(fs.existsSync(path.join(dir, 'a', '깨진.mp4')));
  assert.strictEqual(fs.readdirSync(dir).some((name) => REMOVAL_LOG.test(name)), false, 'no separate log file any more');
});

test('without an open journal run nothing is written and an error is raised', () => {
  const dir = tempDir();
  make(dir, { 'a.mp4': 'x' });
  assert.throws(() => writeRemovalLog(dir, 'duplicates', [{ path: 'a.mp4', reason: 'r' }], { now }), /change journal is not open/);
});

test('the outcomes are added as lines and merged into the items when read', () => {
  const dir = tempDir();
  make(dir, { 'a.mp4': 'x', 'b.mp4': 'y' });
  const result = inRun(dir, () => {
    const log = writeRemovalLog(dir, 'duplicates', [{ path: 'a.mp4', reason: 'r' }, { path: 'b.mp4', reason: 'r' }], { now });
    updateRemovalLog(log, new Map([[0, { outcome: 'removed' }], [1, { outcome: 'failed', error: 'in use' }]]));
    return log;
  });
  const record = readRecord(result.path);
  assert.deepStrictEqual(record.items.map((item) => [item.outcome, item.error]), [['removed', undefined], ['failed', 'in use']]);
  assert.strictEqual(logs(dir).length, 1);
});

test('details and awkward reasons are kept as they are', () => {
  const dir = tempDir();
  make(dir, { '=cmd,a.mp4': 'x' });
  const reason = '줄\n바꿈,"따옴표"\t=1+1';
  const details = { width: 640, keep: path.join(dir, 'k.mp4'), criteria: { minHeight: 360 } };
  const result = inRun(dir, () => writeRemovalLog(dir, 'duplicates', [{ path: '=cmd,a.mp4', reason, details }], { now }));
  const record = readRecord(result.path);
  assert.strictEqual(record.items[0].reason, reason);
  assert.deepStrictEqual(record.items[0].details, details);
  details.width = 1;
  assert.strictEqual(result.items[0].details.width, 640, 'the returned items do not follow later changes of the input');
});

test('the journal and an old record file cannot be removal targets', () => {
  const dir = tempDir();
  make(dir, { 'fctl-removed-2026-01-01-000000.json': '{}', '.fctl-journal/x.jsonl': '' });
  for (const name of ['fctl-removed-2026-01-01-000000.json', '.fctl-journal/x.jsonl']) {
    assert.throws(() => inRun(dir, () => writeRemovalLog(dir, 'duplicates', [{ path: name, reason: 'r' }], { now })), /cannot be a removal target/);
  }
});

test('a failed flush stops before anything is removed', (t) => {
  const dir = tempDir();
  make(dir, { 'a.mp4': 'x' });
  t.mock.method(fs, 'fsyncSync', () => {
    throw Object.assign(new Error('disk'), { code: 'ENOSPC' });
  });
  assert.throws(() => inRun(dir, () => writeRemovalLog(dir, 'duplicates', [{ path: 'a.mp4', reason: 'r' }], { now })), /Nothing was deleted\. \(ENOSPC\)/);
  t.mock.restoreAll();
  assert.ok(fs.existsSync(path.join(dir, 'a.mp4')));
});

test('the preview checks the targets but writes nothing', () => {
  const dir = tempDir();
  make(dir, { 'a.mp4': 'x' });
  const result = writeRemovalLog(dir, 'duplicates', [{ path: 'a.mp4', reason: 'r' }], { now, dryRun: true });
  assert.strictEqual(result.path, undefined);
  assert.deepStrictEqual(result.items.map((item) => item.path), [path.join(dir, 'a.mp4')]);
  assert.throws(() => writeRemovalLog(dir, 'duplicates', [{ path: 'none.mp4', reason: 'r' }], { now, dryRun: true }), FcError);
});

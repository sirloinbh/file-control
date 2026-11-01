'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FcError } = require('../src/commands');
const { writeRemovalLog } = require('../src/removalLog');

// 임시 폴더가 실제 사용자 폴더의 AppData 아래에 있어 보호 경로로 거부되므로 사용자 폴더를 가짜 경로로 바꿔 둔다.
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
const NAME = 'fctl-removed-2026-11-01-090507.json';
const logs = (dir) => fs.readdirSync(dir).filter((name) => name.startsWith('fctl-removed-')).sort();
const readLog = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('경로·크기·사유를 날짜가 붙은 파일로 타겟 폴더에 남기고 대상은 지우지 않는다', () => {
  const dir = tempDir();
  make(dir, { 'a/깨진.mp4': '12345', 'b.mkv': '' });
  const result = writeRemovalLog(dir, '깨진 파일', [{ path: 'a/깨진.mp4', reason: '헤더 불일치' }, { path: path.join(dir, 'b.mkv'), reason: '크기 0' }], { now });
  assert.deepStrictEqual(result, { path: path.join(dir, NAME), count: 2, dryRun: false });
  const log = readLog(result.path);
  assert.strictEqual(log.kind, '깨진 파일');
  assert.match(log.createdAt, /^2026-11-01T09:05:07[+-]\d{2}:\d{2}$/);
  assert.strictEqual(log.target, dir);
  assert.strictEqual(log.count, 2);
  assert.deepStrictEqual(log.items, [
    { path: path.join(dir, 'a', '깨진.mp4'), size: 5, reason: '헤더 불일치' },
    { path: path.join(dir, 'b.mkv'), size: 0, reason: '크기 0' },
  ]);
  assert.ok(fs.existsSync(path.join(dir, 'a', '깨진.mp4')));
  assert.ok(fs.existsSync(path.join(dir, 'b.mkv')));
});

test('종류마다 다른 값은 details로 남긴다', () => {
  const dir = tempDir();
  make(dir, { 'a.mp4': 'x' });
  const details = { width: 320, height: 240, bitrate: 200000, keep: 'b.mp4' };
  const result = writeRemovalLog(dir, '저화질', [{ path: 'a.mp4', reason: '360p 미만', details }], { now });
  assert.deepStrictEqual(readLog(result.path).items[0].details, details);
});

test('사유의 줄바꿈과 제어 문자, =로 시작하는 이름도 그대로 되살린다', () => {
  const dir = tempDir();
  make(dir, { '=cmd,a.mp4': 'x' });
  const reason = '제목 "x"\r\n\u202Eevil\t\\';
  const result = writeRemovalLog(dir, '깨진 파일', [{ path: '=cmd,a.mp4', reason }], { now });
  const log = readLog(result.path);
  assert.strictEqual(log.items[0].reason, reason);
  assert.strictEqual(path.basename(log.items[0].path), '=cmd,a.mp4');
  assert.strictEqual(fs.readFileSync(result.path, 'utf8').split('\n').filter((line) => line.includes('evil')).length, 1);
});

test('같은 이름의 기록이 있으면 덮어쓰지 않고 다음 번호를 쓴다', () => {
  const dir = tempDir();
  make(dir, { 'a.mp4': 'x', [NAME]: '먼저 쓴 기록' });
  const second = writeRemovalLog(dir, '중복', [{ path: 'a.mp4', reason: 'r' }], { now });
  const third = writeRemovalLog(dir, '중복', [{ path: 'a.mp4', reason: 'r' }], { now });
  assert.strictEqual(path.basename(second.path), 'fctl-removed-2026-11-01-090507-2.json');
  assert.strictEqual(path.basename(third.path), 'fctl-removed-2026-11-01-090507-3.json');
  assert.strictEqual(fs.readFileSync(path.join(dir, NAME), 'utf8'), '먼저 쓴 기록');
});

test('확인과 생성 사이에 이름이 차면 그 파일을 건드리지 않고 다음 번호를 쓴다', (t) => {
  const dir = tempDir();
  make(dir, { 'a.mp4': 'x' });
  const openSync = fs.openSync;
  t.mock.method(fs, 'openSync', (file, flags, ...rest) => {
    if (flags === 'wx' && String(file).endsWith(NAME)) fs.writeFileSync(file, '다른 프로그램');
    return openSync(file, flags, ...rest);
  });
  const result = writeRemovalLog(dir, '중복', [{ path: 'a.mp4', reason: 'r' }], { now });
  t.mock.restoreAll();
  assert.strictEqual(path.basename(result.path), 'fctl-removed-2026-11-01-090507-2.json');
  assert.strictEqual(fs.readFileSync(path.join(dir, NAME), 'utf8'), '다른 프로그램');
});

test('이름 자리가 끊어진 정션이면 타겟 밖에 만들지 않는다', () => {
  const dir = tempDir();
  const outside = tempDir();
  make(dir, { 'a.mp4': 'x' });
  const gone = path.join(outside, 'gone');
  fs.mkdirSync(gone);
  fs.symlinkSync(gone, path.join(dir, NAME), 'junction');
  fs.rmdirSync(gone);
  const result = writeRemovalLog(dir, '중복', [{ path: 'a.mp4', reason: 'r' }], { now });
  assert.strictEqual(path.basename(result.path), 'fctl-removed-2026-11-01-090507-2.json');
  assert.deepStrictEqual(fs.readdirSync(outside), []);
});

test('빈 자리를 찾지 못하면 오류를 낸다', (t) => {
  const dir = tempDir();
  make(dir, { 'a.mp4': 'x' });
  const lstatSync = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (p, options) => (path.basename(String(p)).startsWith('fctl-removed-') ? { isFile: () => true } : lstatSync(p, options)));
  assert.throws(() => writeRemovalLog(dir, '중복', [{ path: 'a.mp4', reason: 'r' }], { now }), /기록 파일 이름을 정하지 못했습니다/);
});

test('미리보기는 대상을 검사하고 쓸 이름을 돌려주지만 파일을 만들지 않는다', () => {
  const dir = tempDir();
  make(dir, { 'a.mp4': 'x' });
  const result = writeRemovalLog(dir, '중복', [{ path: 'a.mp4', reason: 'r' }], { now, dryRun: true });
  assert.deepStrictEqual(result, { path: path.join(dir, NAME), count: 1, dryRun: true });
  assert.deepStrictEqual(logs(dir), []);
  assert.throws(() => writeRemovalLog(dir, '중복', [{ path: 'none.mp4', reason: 'r' }], { now, dryRun: true }), FcError);
});

test('대상이 없으면 파일을 만들지 않고 null을 돌려준다', () => {
  const dir = tempDir();
  assert.strictEqual(writeRemovalLog(dir, '중복', [], { now }), null);
  assert.deepStrictEqual(logs(dir), []);
});

test('대상 하나라도 기록할 수 없으면 아무것도 남기지 않는다', () => {
  const dir = tempDir();
  const outside = tempDir();
  make(dir, { 'a.mp4': 'x', 'folder/b.mp4': 'y' });
  make(outside, { 'o.mp4': 'z' });
  fs.symlinkSync(outside, path.join(dir, 'link'), 'junction');
  const cases = [
    [{ path: 'none.mp4', reason: 'r' }, /경로가 없거나/],
    [{ path: 'folder', reason: 'r' }, /파일이 아니라/],
    [{ path: 'link', reason: 'r' }, /링크는 삭제할 수 없습니다/],
    [{ path: 'link/o.mp4', reason: 'r' }, /타겟 폴더 밖/],
    [{ path: path.join(outside, 'o.mp4'), reason: 'r' }, /타겟 폴더 밖/],
    [{ path: 'a.mp4' }, /제거 사유가 없습니다/],
    [{ path: 'a.mp4', reason: '' }, /제거 사유가 없습니다/],
    [{ reason: 'r' }, /경로가 올바르지 않습니다/],
    [null, /경로가 올바르지 않습니다/],
  ];
  for (const [bad, message] of cases) {
    assert.throws(() => writeRemovalLog(dir, '중복', [{ path: 'a.mp4', reason: 'r' }, bad], { now }), (err) => err instanceof FcError && message.test(err.message));
  }
  assert.deepStrictEqual(logs(dir), []);
});

test('같은 파일이 두 번 있으면 표기가 달라도 거부한다', () => {
  const dir = tempDir();
  make(dir, { 'a.mp4': 'x' });
  assert.throws(() => writeRemovalLog(dir, '중복', [{ path: 'a.mp4', reason: 'r' }, { path: path.join(dir, 'a.mp4'), reason: 'r' }], { now }), /같은 파일이 두 번/);
  assert.deepStrictEqual(logs(dir), []);
});

test('종류와 목록이 잘못되면 거부한다', () => {
  const dir = tempDir();
  assert.throws(() => writeRemovalLog(dir, '', []), /제거 종류/);
  assert.throws(() => writeRemovalLog(dir, undefined, []), /제거 종류/);
  assert.throws(() => writeRemovalLog(dir, '중복', 'a.mp4'), /목록이어야/);
});

test('보호 경로는 거부한다', () => {
  assert.throws(() => writeRemovalLog(process.env.SystemRoot ?? 'C:\\Windows', '중복', []), FcError);
});

for (const method of ['writeFileSync', 'fsyncSync', 'closeSync']) {
  test(`${method}가 실패하면 쓰다 만 기록을 지우고 오류를 낸다`, (t) => {
    const dir = tempDir();
    make(dir, { 'a.mp4': 'x' });
    const original = fs[method];
    const mock = t.mock.method(fs, method, (...args) => {
      if (typeof args[0] === 'number') {
        if (method === 'closeSync') original(...args);
        throw Object.assign(new Error('full'), { code: 'ENOSPC' });
      }
      return original(...args);
    });
    assert.throws(() => writeRemovalLog(dir, '중복', [{ path: 'a.mp4', reason: 'r' }], { now }), (err) => err instanceof FcError && /기록 파일을 쓰지 못했습니다.*ENOSPC/.test(err.message));
    mock.mock.restore();
    assert.deepStrictEqual(logs(dir), []);
    assert.ok(fs.existsSync(path.join(dir, 'a.mp4')));
  });
}

test('쓰다 만 기록을 지우지도 못하면 그 사실을 알린다', (t) => {
  const dir = tempDir();
  make(dir, { 'a.mp4': 'x' });
  const fsyncSync = t.mock.method(fs, 'fsyncSync', () => {
    throw Object.assign(new Error('io'), { code: 'EIO' });
  });
  const rmSync = t.mock.method(fs, 'rmSync', () => {
    throw Object.assign(new Error('busy'), { code: 'EBUSY' });
  });
  assert.throws(() => writeRemovalLog(dir, '중복', [{ path: 'a.mp4', reason: 'r' }], { now }), /지우지도 못했습니다.*EIO, EBUSY/);
  fsyncSync.mock.restore();
  rmSync.mock.restore();
});

test('기록 파일을 만들 수 없으면 FcError를 낸다', (t) => {
  const dir = tempDir();
  make(dir, { 'a.mp4': 'x' });
  const openSync = fs.openSync;
  t.mock.method(fs, 'openSync', (file, flags, ...rest) => {
    if (flags === 'wx') throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return openSync(file, flags, ...rest);
  });
  assert.throws(() => writeRemovalLog(dir, '중복', [{ path: 'a.mp4', reason: 'r' }], { now }), (err) => err instanceof FcError && /기록 파일을 만들지 못했습니다.*EACCES/.test(err.message));
});

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FcError } = require('../src/commands');
const { planProductNames, applyProductNames, addProductNumbers, formatProductNumbers } = require('../src/productName');
const { run } = require('../bin/fctl');

// 임시 폴더가 실제 사용자 폴더의 AppData 아래에 있어 보호 경로로 거부되므로 사용자 폴더를 가짜 경로로 바꿔 둔다.
test.mock.method(os, 'homedir', () => path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home'));

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-name-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync.native(dir);
}

function make(dir, files) {
  for (const file of files) {
    const full = path.join(dir, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, file);
  }
}

function tree(dir) {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).replaceAll(path.sep, '/'))
    .sort();
}

const u32 = (value) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(value);
  return b;
};

function box(type, ...parts) {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(body.length + 8), Buffer.from(type, 'latin1'), body]);
}

// 제목과 코멘트만 든 최소 MP4
function mp4({ title, comment }) {
  const item = (type, text) => box(type, box('data', u32(1), u32(0), Buffer.from(text, 'utf8')));
  const items = [title !== undefined && item('©nam', title), comment !== undefined && item('©cmt', comment)].filter(Boolean);
  return Buffer.concat([box('ftyp', Buffer.from('isom')), box('moov', box('udta', box('meta', u32(0), box('ilst', ...items))))]);
}

test('폴더명의 번호를 파일명 앞에 넣는다', () => {
  const dir = tempDir();
  make(dir, ['ABC-123 제목/video.mp4', 'ABC-123 제목/CD2.MKV']);
  const result = addProductNumbers(dir);
  assert.deepStrictEqual(tree(dir), ['ABC-123 제목/ABC-123 CD2.MKV', 'ABC-123 제목/ABC-123 video.mp4']);
  assert.strictEqual(result.renamed.length, 2);
  assert.strictEqual(result.renamed[0].source, 'folder');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'ABC-123 제목', 'ABC-123 video.mp4'), 'utf8'), 'ABC-123 제목/video.mp4');
});

test('메타데이터 제목과 코멘트의 번호를 넣는다', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.mp4'), mp4({ title: 'ABC-123 제목' }));
  fs.writeFileSync(path.join(dir, 'b.mov'), mp4({ comment: 'XYZ-999 메모' }));
  const result = addProductNumbers(dir);
  assert.deepStrictEqual(tree(dir), ['ABC-123 a.mp4', 'XYZ-999 b.mov']);
  assert.deepStrictEqual(result.renamed.map((item) => item.source), ['title', 'comment']);
});

test('제목의 다른 글자는 이름에 넣지 않는다', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.mp4'), mp4({ title: '..\\..\\evil\r\n\u202EABC-123 gpj.exe' }));
  addProductNumbers(dir);
  assert.deepStrictEqual(tree(dir), ['ABC-123 a.mp4']);
});

test('파일명에 대문자 번호가 있으면 건너뛰고 메타데이터를 읽지 않으며, 보고에 번호를 적는다', (t) => {
  const dir = tempDir();
  make(dir, ['ABC-123.mp4', 'XYZ-999/ABC-789 제목.mp4']);
  const readSync = t.mock.method(fs, 'readSync');
  const result = addProductNumbers(dir);
  assert.strictEqual(readSync.mock.callCount(), 0);
  assert.deepStrictEqual(tree(dir), ['ABC-123.mp4', 'XYZ-999/ABC-789 제목.mp4']);
  assert.deepStrictEqual(result.already.map((item) => item.number).sort(), ['ABC-123', 'ABC-789']);
  assert.strictEqual(result.renamed.length, 0);
  assert.match(formatProductNumbers(result), /이미 있음: ABC-123\.mp4 \(ABC-123\)/);
});

test('파일명의 소문자 번호는 다른 곳에 번호가 없거나 같으면 건너뛰고, 다르면 엇갈림으로 보고한다', () => {
  const dir = tempDir();
  make(dir, ['영상 abc-456.mkv', 'ABC-123/abc-123 x.mp4', 'ABC-123/intro-01.mp4', 'ABC-123/summer-2023.mkv']);
  fs.writeFileSync(path.join(dir, 'trip-2023.mp4'), mp4({ title: 'XYZ-999 t' }));
  const result = addProductNumbers(dir);
  assert.strictEqual(result.renamed.length, 0);
  assert.deepStrictEqual(result.already.map((item) => item.number).sort(), ['ABC-123', 'ABC-456']);
  assert.deepStrictEqual(result.conflicts.map((item) => item.numbers).sort(), [
    ['INTRO-01', 'ABC-123'],
    ['SUMMER-2023', 'ABC-123'],
    ['TRIP-2023', 'XYZ-999'],
  ]);
});

test('파일명에 글자가 붙은 번호가 있으면 같은 번호를 또 넣지 않는다', () => {
  const dir = tempDir();
  const files = ['ABC-123-01.mp4', 'abc-123-02.mp4', 'ABC-123A.mp4', 'ABC-123CD1.mkv', '1ABC-123.mp4', 'Abc-123.mp4'].map((name) => `ABC-123/${name}`);
  make(dir, files);
  const result = addProductNumbers(dir);
  assert.deepStrictEqual(tree(dir), [...files].sort());
  assert.strictEqual(result.already.length, files.length);
});

test('번호의 일부만 겹치는 이름에는 번호를 넣는다', () => {
  const dir = tempDir();
  make(dir, ['ABC-123/ABC-1234x.mp4', 'ABC-123/QWERTYABC-123.mp4']);
  addProductNumbers(dir);
  assert.deepStrictEqual(tree(dir), ['ABC-123/ABC-123 ABC-1234x.mp4', 'ABC-123/ABC-123 QWERTYABC-123.mp4']);
});

test('.ts와 .mts는 전송 스트림일 때만 영상으로 본다', () => {
  const dir = tempDir();
  make(dir, ['PROJ-123/src/index.ts', 'PROJ-123/src/mod.mts', 'PROJ-123/short.ts']);
  const packets = (start, step) => {
    const data = Buffer.alloc(start + step * 3);
    for (let i = start; i < data.length; i += step) data[i] = 0x47;
    return data;
  };
  fs.writeFileSync(path.join(dir, 'PROJ-123', 'a.ts'), packets(0, 188));
  fs.writeFileSync(path.join(dir, 'PROJ-123', 'b.mts'), packets(4, 192));
  const result = addProductNumbers(dir);
  assert.deepStrictEqual(tree(dir), ['PROJ-123/PROJ-123 a.ts', 'PROJ-123/PROJ-123 b.mts', 'PROJ-123/short.ts', 'PROJ-123/src/index.ts', 'PROJ-123/src/mod.mts']);
  assert.strictEqual(result.notFound.length + result.skipped.length, 0);
});

test('파일을 확인하다 난 시스템 오류는 그 파일만 건너뛴다', (t) => {
  const dir = tempDir();
  make(dir, ['ABC-123/a.mp4', 'ABC-123/b.mp4']);
  const lstatSync = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (p, options) => {
    if (String(p).endsWith('ABC-123 a.mp4')) throw Object.assign(new Error('denied'), { code: 'EPERM', syscall: 'lstat' });
    return lstatSync(p, options);
  });
  const plan = planProductNames(dir);
  t.mock.restoreAll();
  assert.match(plan.skipped[0].reason, /EPERM/);
  assert.strictEqual(plan.renames.length, 1);
});

test('계획 뒤에 원본이나 부모가 바뀌면 그 파일만 실패하고 타겟 밖을 바꾸지 않는다', () => {
  const dir = tempDir();
  const outside = tempDir();
  make(outside, ['a.mp4']);
  make(dir, ['ABC-123/link.mp4', 'ABC-123/folder.mp4', 'ABC-123/ok.mp4', 'XYZ-999/p.mp4']);
  const plan = planProductNames(dir);
  fs.rmSync(path.join(dir, 'ABC-123', 'link.mp4'));
  fs.symlinkSync(outside, path.join(dir, 'ABC-123', 'link.mp4'), 'junction');
  fs.rmSync(path.join(dir, 'ABC-123', 'folder.mp4'));
  fs.mkdirSync(path.join(dir, 'ABC-123', 'folder.mp4'));
  fs.rmSync(path.join(dir, 'XYZ-999'), { recursive: true });
  fs.symlinkSync(outside, path.join(dir, 'XYZ-999'), 'junction');
  fs.writeFileSync(path.join(outside, 'p.mp4'), 'o');
  const result = applyProductNames(plan);
  assert.deepStrictEqual(result.renamed.map((item) => item.name), ['ABC-123 ok.mp4']);
  assert.strictEqual(result.failed.length, 3);
  assert.deepStrictEqual(fs.readdirSync(outside).sort(), ['a.mp4', 'p.mp4']);
});

test('실행 때 대상이 끊어진 정션이면 원본을 남기고 타겟 밖에 만들지 않는다', () => {
  const dir = tempDir();
  const outside = tempDir();
  make(dir, ['ABC-123/a.mp4']);
  const plan = planProductNames(dir);
  const gone = path.join(outside, 'gone');
  fs.mkdirSync(gone);
  fs.symlinkSync(gone, path.join(dir, 'ABC-123', 'ABC-123 a.mp4'), 'junction');
  fs.rmdirSync(gone);
  const result = applyProductNames(plan);
  assert.strictEqual(result.failed.length, 1);
  assert.ok(fs.existsSync(path.join(dir, 'ABC-123', 'a.mp4')));
  assert.deepStrictEqual(fs.readdirSync(outside), []);
});

test('이름 변경이 실패했을 때 자리표시에 다른 내용이 생겼으면 지우지 않는다', (t) => {
  const dir = tempDir();
  make(dir, ['ABC-123/a.mp4']);
  t.mock.method(fs, 'renameSync', (from, to) => {
    fs.writeFileSync(to, '새 내용');
    throw Object.assign(new Error('busy'), { code: 'EBUSY' });
  });
  const result = addProductNumbers(dir);
  t.mock.restoreAll();
  assert.match(result.failed[0].reason, /지우지 않았습니다/);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'ABC-123', 'ABC-123 a.mp4'), 'utf8'), '새 내용');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'ABC-123', 'a.mp4'), 'utf8'), 'ABC-123/a.mp4');
});

test('두 번 실행해도 번호를 또 넣지 않는다', () => {
  const dir = tempDir();
  make(dir, ['ABC-123/video.mp4']);
  addProductNumbers(dir);
  const again = addProductNumbers(dir);
  assert.deepStrictEqual(tree(dir), ['ABC-123/ABC-123 video.mp4']);
  assert.strictEqual(again.renamed.length, 0);
  assert.strictEqual(again.already.length, 1);
});

test('못 찾은 파일을 목록으로 보고하고 건드리지 않는다', () => {
  const dir = tempDir();
  make(dir, ['video.mkv', '새 폴더/x.avi', 'summer-2023/y.webm']);
  const result = addProductNumbers(dir);
  assert.deepStrictEqual(tree(dir), ['summer-2023/y.webm', 'video.mkv', '새 폴더/x.avi']);
  assert.strictEqual(result.notFound.length, 3);
  assert.strictEqual(result.notFound[0].note, null);
});

test('깨진 MP4는 사유와 함께 못 찾음으로 보고하고, 폴더명에 번호가 있으면 쓴다', () => {
  const dir = tempDir();
  make(dir, ['bad.mp4', 'ABC-123/bad2.mp4']);
  const result = addProductNumbers(dir);
  assert.deepStrictEqual(tree(dir), ['ABC-123/ABC-123 bad2.mp4', 'bad.mp4']);
  assert.match(result.notFound[0].note, /MP4\/MOV 형식이 아닙니다/);
});

test('MP4 계열이 아니면 메타데이터를 읽지 않는다', (t) => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.mkv'), mp4({ title: 'ABC-123' }));
  const readSync = t.mock.method(fs, 'readSync');
  const result = addProductNumbers(dir);
  assert.strictEqual(readSync.mock.callCount(), 0);
  assert.strictEqual(result.notFound[0].note, null);
});

test('영상이 아닌 파일은 다루지도 보고하지도 않는다', () => {
  const dir = tempDir();
  make(dir, ['ABC-123/메모.txt', 'ABC-123/자막.srt', 'noext']);
  const result = addProductNumbers(dir);
  assert.deepStrictEqual(tree(dir), ['ABC-123/메모.txt', 'ABC-123/자막.srt', 'noext']);
  assert.match(formatProductNumbers(result), /이름 변경 0개, 이미 있음 0개, 못 찾음 0개/);
});

test('번호가 엇갈리면 바꾸지 않고 보고한다', () => {
  const dir = tempDir();
  make(dir, ['XYZ-999/ABC-123/video.mp4', 'AAA-111 BBB-222/x.mkv']);
  fs.mkdirSync(path.join(dir, 'CCC-333'));
  fs.writeFileSync(path.join(dir, 'CCC-333', 't.mp4'), mp4({ title: 'DDD-444' }));
  const result = addProductNumbers(dir);
  assert.strictEqual(result.renamed.length, 0);
  assert.deepStrictEqual(result.conflicts.map((item) => item.numbers).sort(), [
    ['AAA-111', 'BBB-222'],
    ['ABC-123', 'XYZ-999'],
    ['DDD-444', 'CCC-333'],
  ]);
  assert.ok(fs.existsSync(path.join(dir, 'CCC-333', 't.mp4')));
});

test('코멘트의 다른 번호는 제목이나 폴더의 번호를 막지 않지만, 코멘트끼리 엇갈리면 고르지 않는다', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.mp4'), mp4({ title: 'ABC-123', comment: 'XYZ-999' }));
  fs.writeFileSync(path.join(dir, 'b.mp4'), mp4({ comment: 'AAA-111 BBB-222' }));
  const result = addProductNumbers(dir);
  assert.deepStrictEqual(tree(dir), ['ABC-123 a.mp4', 'b.mp4']);
  assert.deepStrictEqual(result.conflicts[0].numbers, ['AAA-111', 'BBB-222']);
});

test('타겟 자신의 폴더 이름은 쓰지 않는다', () => {
  const parent = tempDir();
  make(parent, ['ABC-123/video.mp4']);
  const result = addProductNumbers(path.join(parent, 'ABC-123'));
  assert.strictEqual(result.notFound.length, 1);
  assert.deepStrictEqual(tree(parent), ['ABC-123/video.mp4']);
});

test('같은 이름이 있으면 덮어쓰지 않고 건너뛴다', () => {
  const dir = tempDir();
  make(dir, ['ABC-123/video.mp4', 'ABC-123/ABC-123 video.mp4']);
  fs.mkdirSync(path.join(dir, 'XYZ-999', 'XYZ-999 v.mp4'), { recursive: true });
  make(dir, ['XYZ-999/v.mp4']);
  const result = addProductNumbers(dir);
  assert.strictEqual(result.renamed.length, 0);
  assert.strictEqual(result.skipped.length, 2);
  assert.match(result.skipped[0].reason, /같은 이름이 이미 있어/);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'ABC-123', 'ABC-123 video.mp4'), 'utf8'), 'ABC-123/ABC-123 video.mp4');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'ABC-123', 'video.mp4'), 'utf8'), 'ABC-123/video.mp4');
});

test('계획 뒤에 이름이 차면 덮어쓰지 않고 실패로 보고한다', (t) => {
  const dir = tempDir();
  make(dir, ['ABC-123/a.mp4', 'ABC-123/b.mp4']);
  const openSync = fs.openSync;
  t.mock.method(fs, 'openSync', (file, flags, ...rest) => {
    if (flags === 'wx' && String(file).endsWith('ABC-123 a.mp4')) fs.writeFileSync(file, '새 내용');
    return openSync(file, flags, ...rest);
  });
  const result = addProductNumbers(dir);
  t.mock.restoreAll();
  assert.match(result.failed[0].reason, /같은 이름이 이미 있어/);
  assert.strictEqual(result.renamed.length, 1);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'ABC-123', 'ABC-123 a.mp4'), 'utf8'), '새 내용');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'ABC-123', 'a.mp4'), 'utf8'), 'ABC-123/a.mp4');
});

test('이름 변경이 실패하면 자리표시를 지우고 나머지를 계속한다', (t) => {
  const dir = tempDir();
  make(dir, ['ABC-123/a.mp4', 'ABC-123/b.mp4']);
  const renameSync = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (String(from).endsWith('a.mp4')) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return renameSync(from, to);
  });
  const result = addProductNumbers(dir);
  t.mock.restoreAll();
  assert.match(result.failed[0].reason, /EBUSY/);
  assert.deepStrictEqual(tree(dir), ['ABC-123/ABC-123 b.mp4', 'ABC-123/a.mp4']);
});

test('이름이 너무 길어지면 건너뛴다', () => {
  const dir = tempDir();
  const long = `${'가'.repeat(248)}.mp4`;
  make(dir, [`ABC-123/${long}`]);
  const result = addProductNumbers(dir);
  assert.match(result.skipped[0].reason, /이름이 너무 깁니다/);
  assert.deepStrictEqual(tree(dir), [`ABC-123/${long}`]);
});

test('잔여물, 시스템 폴더, 저장소 안의 파일, 점 파일은 건드리지 않고 보고한다', () => {
  const dir = tempDir();
  const files = ['.fctl-old-1-2-0/ABC-123/a.mp4', '$RECYCLE.BIN/ABC-123/b.mp4', '.git/ABC-123/c.mp4', 'ABC-123/.d.mp4'];
  make(dir, files);
  const result = addProductNumbers(dir);
  assert.deepStrictEqual(tree(dir), [...files].sort());
  assert.strictEqual(result.skipped.length, 4);
  assert.strictEqual(result.renamed.length, 0);
});

test('링크는 바꾸지 않고, 타겟 밖을 가리키는 정션 안으로 들어가지 않는다', () => {
  const dir = tempDir();
  const outside = tempDir();
  make(outside, ['ABC-123/a.mp4']);
  fs.symlinkSync(path.join(outside, 'ABC-123'), path.join(dir, 'XYZ-999.mp4'), 'junction');
  fs.symlinkSync(path.join(outside, 'ABC-123'), path.join(dir, 'ABC-123'), 'junction');
  const result = addProductNumbers(dir);
  assert.strictEqual(result.skipped.length, 2);
  assert.match(result.skipped[0].reason, /링크/);
  assert.match(result.skipped[1].reason, /링크/);
  assert.deepStrictEqual(tree(outside), ['ABC-123/a.mp4']);
});

test('해석이 갈리는 이름은 건너뛴다', () => {
  const dir = tempDir();
  make(dir, ['ABC-123/x.mp4']);
  fs.renameSync(path.join(dir, 'ABC-123', 'x.mp4'), `\\\\?\\${path.join(dir, 'ABC-123', 'Con.Air.mp4')}`);
  const result = addProductNumbers(dir);
  assert.strictEqual(result.skipped.length, 1);
  assert.strictEqual(result.renamed.length, 0);
});

test('미리보기는 아무것도 바꾸지 않고 같은 계획을 보여 준다', () => {
  const dir = tempDir();
  make(dir, ['ABC-123/video.mp4']);
  const result = addProductNumbers(dir, { dryRun: true });
  assert.deepStrictEqual(tree(dir), ['ABC-123/video.mp4']);
  assert.strictEqual(result.renamed[0].name, 'ABC-123 video.mp4');
  assert.match(formatProductNumbers(result), /\[미리보기\] 이름 변경: ABC-123[\\/]video\.mp4 -> ABC-123 video\.mp4 \(폴더명\)/);
  assert.strictEqual(fs.lstatSync(path.join(dir, 'ABC-123')).isDirectory(), true);
});

test('planProductNames는 파일을 바꾸지 않는다', () => {
  const dir = tempDir();
  make(dir, ['ABC-123/video.mp4']);
  const plan = planProductNames(dir);
  assert.strictEqual(plan.renames[0].to, path.join(dir, 'ABC-123', 'ABC-123 video.mp4'));
  assert.deepStrictEqual(tree(dir), ['ABC-123/video.mp4']);
});

test('보호 경로는 거부한다', () => {
  assert.throws(() => addProductNumbers(process.env.SystemRoot ?? 'C:\\Windows'), FcError);
});

test('product-number 명령은 결과를 보여 주고 실패가 있으면 오류로 끝낸다', (t) => {
  const dir = tempDir();
  make(dir, ['ABC-123/a.mp4', 'b.mkv']);
  assert.match(run(['product-number', dir, '--dry-run']), /\[미리보기\] 이름 변경 1개, 이미 있음 0개, 못 찾음 1개/);
  assert.deepStrictEqual(tree(dir), ['ABC-123/a.mp4', 'b.mkv']);
  const renameSync = t.mock.method(fs, 'renameSync', () => {
    throw Object.assign(new Error('busy'), { code: 'EBUSY' });
  });
  assert.throws(() => run(['product-number', dir]), (err) => err instanceof FcError && /실패: .*EBUSY/.test(err.message));
  renameSync.mock.restore();
  assert.match(run(['product-number', dir]), /못 찾음: b\.mkv\n이름 변경 1개/);
  assert.deepStrictEqual(tree(dir), ['ABC-123/ABC-123 a.mp4', 'b.mkv']);
});

test('product-number 명령은 잘못된 인자를 거부한다', () => {
  const dir = tempDir();
  assert.throws(() => run(['product-number']), /사용법/);
  assert.throws(() => run(['product-number', dir, 'more']), /타겟은 하나만/);
  assert.throws(() => run(['product-number', 'C:']), /드라이브 문자/);
  assert.throws(() => run(['product-number', dir, '--force']), /--force/);
  assert.throws(() => run(['product-number', dir, '--permanent']), /--permanent/);
});

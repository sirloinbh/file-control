'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { describeArchiveFormat, extractAllView } = require('../src/ui/archive');
const { toPlain } = require('../src/ui/serialize');

test('describeArchiveFormat는 tar.exe -a가 확장자로 정할 형식을 설명한다 (#258)', () => {
  // 첫 바이트로 확인한 tar.exe(빌드 26200) 결과와 맞춘다: .tlz는 lzma, .taZ·.tZ는 compress, .tz·.z·.jar는 압축 없는 tar.
  const cases = {
    'a.zip': 'ZIP',
    'A.ZIP': 'ZIP',
    'x.tar.zip': 'ZIP',
    'x.7z': '7z',
    'x.iso': 'ISO 9660',
    'x.tar': 'tar (압축 없음)',
    'x.tar.gz': 'tar + gzip',
    'x.TGZ': 'tar + gzip',
    'x.gz': 'tar + gzip',
    'x.taz': 'tar + gzip',
    'x.tlz': 'tar + lzma',
    'x.taZ': 'tar + compress',
    'x.tZ': 'tar + compress',
    'x.Z': 'tar + compress',
    'x.tar.gz.gz': 'tar + gzip + gzip',
    'x.cpio.xz': 'cpio + xz',
    [path.join('D:\\', 'p.q', 'x.tar.bz2')]: 'tar + bzip2',
    'x.tz': 'tar (압축 없음) - .tz는 형식으로 읽지 않는 확장자입니다',
    'x.z': 'tar (압축 없음) - .z는 형식으로 읽지 않는 확장자입니다',
    'x.jar': 'tar (압축 없음) - .jar는 형식으로 읽지 않는 확장자입니다',
    x: 'tar (압축 없음) - 확장자가 없습니다',
  };
  for (const [name, label] of Object.entries(cases)) assert.strictEqual(describeArchiveFormat(name).label, label, name);
  assert.deepStrictEqual(describeArchiveFormat('x.tar.gz.xz'), { ext: '.tar.gz.xz', format: 'tar', layers: ['gzip', 'xz'], label: 'tar + gzip + xz' });
});

// extractArchives 결과 모양(JSON으로 옮긴 것).
function outcome(fields) {
  const target = path.join('D:\\', 'dl');
  const p = (...parts) => path.join(target, ...parts);
  return toPlain({
    command: 'extract-all',
    result: {
      target,
      dryRun: false,
      removeArchives: true,
      extracted: [
        { archive: p('a.zip'), dest: p('a'), entries: 3 },
        { archive: p('b.7z'), dest: p('b (2)'), entries: 1 },
        { archive: p('c.zip'), dest: p('c'), entries: 2 },
      ],
      skipped: [{ path: p('d.zip'), reason: '같은 이름의 폴더가 있음 <x>' }],
      removed: [p('a.zip')],
      kept: [{ archive: p('b.7z'), reason: '풀린 파일 수가 다름' }],
      failed: [{ archive: p('c.zip'), reason: '휴지통으로 보내지 못함' }, { archive: p('e.zip'), reason: '깨진 압축 파일' }],
      ...fields,
    },
    report: '',
  });
}

const rows = (body) => [...String(body).matchAll(/<tr><td>(.*?)<\/td><\/tr>/g)].map((m) => m[1].split('</td><td>'));

test('extractAllView는 압축 파일마다 풀린 폴더, 원본 처리, 건너뜀·실패 사유를 표로 보인다 (#258)', () => {
  const body = String(extractAllView(outcome()));
  const table = rows(body);
  assert.deepStrictEqual(table.map((cells) => cells[0]), ['a.zip', 'b.7z', 'c.zip', 'e.zip', 'd.zip']);
  assert.deepStrictEqual(table[0].slice(2, 4), ['a', '3']);
  assert.match(table[0][1], /badge-ok">풀림</);
  assert.match(table[0][4], /휴지통으로 보냄/);
  assert.match(table[1][4], /badge-skip">남김<\/span> 풀린 파일 수가 다름/);
  // 풀었지만 원본을 지우지 못한 것은 풀린 줄에 합치고, 풀지 못한 것은 실패 줄로 둔다.
  assert.match(table[2][1], /badge-ok">풀림</);
  assert.strictEqual(table[2][4], '<span class="badge badge-error">원본 처리 실패</span> 휴지통으로 보내지 못함');
  assert.match(table[3][1], /badge-error">실패</);
  assert.strictEqual(table[3][4], '깨진 압축 파일');
  assert.match(table[4][1], /badge-skip">건너뜀</);
  assert.strictEqual(table[4][4], '같은 이름의 폴더가 있음 &lt;x&gt;');
  assert.match(body, /<div class="value">3<\/div><div class="label">푼 압축 파일</);
  assert.match(body, /휴지통으로 보낸 원본/);
  assert.match(body, /card-error"><div class="value">2<\/div><div class="label">실패/);
});

test('extractAllView 미리보기는 "풀 예정"으로 쓰고, --remove-archives가 없으면 원본 칸 요약을 빼며, 빈 결과에는 안내를 보인다 (#258)', () => {
  const preview = String(extractAllView(outcome({ dryRun: true })));
  assert.match(preview, /미리보기: 아직 아무것도 바꾸지 않았습니다/);
  assert.match(preview, /badge-ok">풀 예정</);
  assert.match(preview, /휴지통으로 보낼 예정/);

  const plain = String(extractAllView(outcome({ removeArchives: false, removed: [], kept: [], failed: [], skipped: [] })));
  assert.doesNotMatch(plain, /원본<\/div>/);
  const empty = String(extractAllView(outcome({ extracted: [], removed: [], kept: [], failed: [], skipped: [] })));
  assert.match(empty, /압축 파일이 없습니다\./);
});

test('extractAllView는 --remove-archives가 없으면 원본을 "그대로 둠"으로 보인다 (#258)', () => {
  const body = String(extractAllView(outcome({ removeArchives: false, removed: [], kept: [], failed: [] })));
  assert.deepStrictEqual(rows(body).slice(0, 3).map((cells) => cells[4]), ['그대로 둠', '그대로 둠', '그대로 둠']);
});

'use strict';

// 폴더 정리 화면(#257)의 결과 표: 요약 카드, 실패·건너뜀을 위에, 바뀐 이름 부분 강조.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 임시 폴더가 실제 사용자 폴더의 AppData 아래라 보호 폴더로 거부되므로 사용자 폴더를 바꿔 둔다.
const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fc-ui-organize-')));
test.after(() => fs.rmSync(base, { recursive: true, force: true }));
test.mock.method(os, 'homedir', () => path.join(base, 'home'));

const { highlightChange, organizeResultView, ORGANIZE_COMMANDS } = require('../src/ui/organizeResults');
const { flatten } = require('../src/flatten');
const { toPlain } = require('../src/ui/serialize');

// 작업 프로세스에서 건너온 것처럼 JSON을 한 번 거친다(#253).
const overJson = (result) => JSON.parse(JSON.stringify(toPlain(result)));

function make(dir, files) {
  for (const file of files) {
    fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), file);
  }
}

// 본문에서 a가 b보다 앞에 나오면 true
const before = (body, a, b) => body.indexOf(a) >= 0 && body.indexOf(b) > body.indexOf(a);

test('highlightChange는 새 이름에서 붙거나 바뀐 부분만 강조하고 이름은 이스케이프한다 (#257)', () => {
  assert.strictEqual(highlightChange('video.mp4', 'Show CD1 video.mp4').text, '<mark>Show CD1 </mark>video.mp4');
  assert.strictEqual(highlightChange('abc.mp4', 'ABC-123 abc.mp4').text, '<mark>ABC-123 </mark>abc.mp4');
  assert.strictEqual(highlightChange('video.en.srt', 'Show video.Forced.en.srt').text, '<mark>Show video.Forced</mark>.en.srt');
  assert.strictEqual(highlightChange('ＡＢＣ.mp4', 'ABC.mp4').text, '<mark>ABC</mark>.mp4');
  // 바뀐 것이 없으면 강조하지 않는다.
  assert.strictEqual(highlightChange('same.mp4', 'same.mp4').text, 'same.mp4');
  // 이름의 <, &, 따옴표는 이스케이프한다. 한글·이모지는 쪼개지 않는다.
  assert.strictEqual(highlightChange('a<b>.mp4', 'X & "Y" a<b>.mp4').text, '<mark>X &amp; &quot;Y&quot; </mark>a&lt;b&gt;.mp4');
  assert.strictEqual(highlightChange('😀.mp4', '😁.mp4').text, '<mark>😁</mark>.mp4');
  assert.strictEqual(highlightChange('영상.mp4', '쇼 영상.mp4').text, '<mark>쇼 </mark>영상.mp4');
});

test('flatten 미리보기 결과: 요약 카드, 건너뜀이 이동보다 위, 붙은 접두어 강조 (#257)', () => {
  const dir = path.join(base, 'flatten');
  make(dir, ['Show/CD1/video.mp4', 'Show/CD1/video.en.srt', 'Show/CD2/<b>.txt'.replace('<b>', 'b&c'), 'old/.fctl-old-1-2-3']);
  const result = overJson(flatten(dir, { dryRun: true }));
  const body = organizeResultView('flatten', result).text;
  assert.match(body, /미리보기/);
  assert.match(body, /<div class="value">3<\/div><div class="label">이동<\/div>/);
  assert.match(body, /<div class="value">1<\/div><div class="label">건너뜀<\/div>/);
  assert.ok(body.includes('<mark>Show CD1 </mark>video.mp4'));
  assert.ok(body.includes('<mark>Show CD1 </mark>video.en.srt'));
  assert.ok(body.includes(path.join('Show', 'CD1', 'video.mp4')), '원본은 타겟 기준 상대경로');
  assert.ok(body.includes('b&amp;c'), '이름 이스케이프');
  assert.ok(before(body, '<h2>건너뜀', '<h2>이동'), '건너뜀이 이동보다 위');
  assert.match(body, /이전 작업의 잔여물/);
  // 없는 항목(실패)은 섹션을 만들지 않는다.
  assert.doesNotMatch(body, /<h2>실패/);
});

test('flatten 실행 결과: 실패·남긴 폴더를 위에, 번호 붙임·폴더명 사용 배지를 보여 준다 (#257)', () => {
  const t = 'D:\\t';
  const result = {
    target: t, dryRun: false, stay: [], removedFolders: ['D:\\t\\Show'],
    moved: [{ from: 'D:\\t\\ABC-123\\video.mp4', name: 'ABC-123.mp4', fromFolder: true, numbered: false }, { from: 'D:\\t\\x\\a.txt', name: 'a (2).txt', fromFolder: false, numbered: true }],
    skipped: [], failed: [{ from: 'D:\\t\\y\\locked.mp4', reason: '잠김' }], keptFolders: [{ path: 'D:\\t\\y', reason: '파일이 남아 있습니다.' }],
  };
  const body = organizeResultView('flatten', overJson(result)).text;
  assert.doesNotMatch(body, /미리보기/);
  assert.ok(before(body, '<h2>실패', '<h2>남긴 폴더') && before(body, '<h2>남긴 폴더', '<h2>이동'));
  assert.ok(body.includes(path.join('y', 'locked.mp4')) && body.includes('잠김'));
  assert.match(body, /폴더명 사용/);
  assert.match(body, /번호 붙임/);
  assert.ok(body.includes('a<mark> (2)</mark>.txt'));
  assert.match(body, /<h2>빈 폴더를 휴지통으로/);
});

test('collapse·normalize·product-number 결과도 실패·건너뜀을 위에 두고 바뀐 부분을 강조한다 (#257)', () => {
  const t = 'D:\\t';
  const collapse = organizeResultView('collapse', overJson({
    target: t, dryRun: true,
    collapsed: [{ leaf: 'D:\\t\\A\\A\\A', dest: 'D:\\t\\A' }],
    skipped: [{ path: 'D:\\t\\B', reason: '이름이 다릅니다.' }], failed: [],
  })).text;
  assert.ok(before(collapse, '<h2>건너뜀', '<h2>접기'));
  assert.ok(collapse.includes(path.join('A', 'A', 'A')));

  const normalize = organizeResultView('normalize', overJson({
    target: t, dryRun: false,
    renamed: [{ from: 'D:\\t\\ＡＢＣ　영상.mp4', name: 'ABC 영상.mp4' }],
    inferred: [{ path: 'D:\\t\\iphone.txt', name: 'IPHONE.txt' }],
    conflicts: [{ path: 'D:\\t\\ｘ.txt', name: 'x.txt', reason: '같은 이름이 있습니다.' }],
    skipped: [], failed: [{ from: 'D:\\t\\z.txt', reason: '잠김' }],
  })).text;
  assert.ok(before(normalize, '<h2>실패', '<h2>이름이 겹침') && before(normalize, '<h2>이름이 겹침', '<h2>이름 변경'));
  assert.ok(normalize.includes('<mark>ABC </mark>영상.mp4'));
  assert.match(normalize, /소문자 말이라 그대로 둠/);

  const product = organizeResultView('product-number', overJson({
    target: t, dryRun: true,
    renamed: [{ from: 'D:\\t\\movie.mp4', name: 'ABC-123 movie.mp4', source: 'title', note: null }],
    already: [{ path: 'D:\\t\\XYZ-001.mp4', number: 'XYZ-001' }],
    notFound: [{ path: 'D:\\t\\clip.mp4', note: null }],
    conflicts: [{ path: 'D:\\t\\two.mp4', numbers: ['AAA-001', 'BBB-002'], note: '읽기 실패' }],
    skipped: [], failed: [],
  })).text;
  assert.ok(product.includes('<mark>ABC-123 </mark>movie.mp4'));
  assert.match(product, /제목에서 찾음/);
  assert.ok(before(product, '<h2>번호가 엇갈림', '<h2>이름 변경'));
  assert.match(product, /AAA-001, BBB-002/);
  assert.match(product, /<h2>이미 있음/);
  assert.match(product, /<h2>못 찾음/);
});

test('organizeResultView는 폴더 정리 명령만 받는다 (#257)', () => {
  assert.deepStrictEqual(ORGANIZE_COMMANDS, ['flatten', 'collapse', 'normalize', 'product-number']);
  assert.throws(() => organizeResultView('rm', {}), /폴더 정리 명령이 아닙니다/);
});

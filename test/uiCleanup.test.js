'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execute } = require('../src/execute');
const { toPlain } = require('../src/ui/serialize');
const { CLEANUP_VIEWS, findBrokenView, findDuplicatesView, findLowQualityView, removeView } = require('../src/ui/cleanup');

// 임시 폴더는 사용자 설정 폴더(AppData) 아래라 보호 경로다. 다른 테스트처럼 사용자 폴더를 없는 곳으로 둔다.
test.mock.method(os, 'homedir', () => path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home'));

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-uicleanup-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 화면이 받는 것과 같게 실제 명령을 실행해 JSON으로 옮긴다.
const run = (argv) => toPlain(execute(argv));
const rows = (body) => [...String(body).matchAll(/<tr><td>(.*?)<\/td><\/tr>/g)].map((m) => m[1].split('</td><td>'));
const T = path.join('D:\\', 'v');
const p = (...parts) => path.join(T, ...parts);

test('CLEANUP_VIEWS는 찾기·지우기 명령 여섯 개의 화면을 모두 갖는다 (#259)', () => {
  assert.deepStrictEqual(Object.keys(CLEANUP_VIEWS).sort(), ['find-broken', 'find-duplicates', 'find-low-quality', 'remove-broken', 'remove-duplicates', 'remove-low-quality']);
});

test('find-broken 화면: 깨짐·의심을 표로, 판단 못함·건너뜀은 따로, 이름은 이스케이프 (#259)', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'bad&1.zip'), 'not a zip');
  fs.writeFileSync(path.join(dir, 'ok.txt'), 'text');
  const body = String(findBrokenView(run(['find-broken', dir])));
  assert.match(body, /<td>bad&amp;1\.zip<\/td><td><span class="badge badge-warning">의심<\/span><\/td><td>9 ?B<\/td><td>내용이 ZIP 형식으로 시작하지 않습니다/);
  assert.match(body, /<div class="value">1<\/div><div class="label">의심/);
  assert.doesNotMatch(body, /살펴보지 못한 파일/);

  const synthetic = toPlain({ command: 'find-broken', result: { target: T, broken: [{ path: p('a.mp4'), size: 10, reason: '잘림' }], suspect: [], unreadable: [{ path: p('b.zip'), reason: '읽기 실패' }], skipped: [{ path: p('l'), reason: '링크는 보지 않습니다.' }], checked: 2 } });
  const table = rows(findBrokenView(synthetic));
  assert.deepStrictEqual(table.map((cells) => cells[0]), ['a.mp4', 'b.zip', 'l']);
  assert.match(table[0][1], /badge-error">깨짐/);
  assert.match(table[1][1], /판단 못함/);
  assert.match(table[2][1], /건너뜀/);
});

test('find-duplicates 화면: 묶음마다 남길 파일과 지울 후보를 나누고 주의 문구를 보인다 (#259)', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'ABC-123 first.mp4'), 'x');
  fs.writeFileSync(path.join(dir, 'ABC-123 second.mp4'), 'xx');
  const outcome = run(['find-duplicates', dir]);
  const body = String(findDuplicatesView(outcome));
  assert.match(body, /<h3>중복 후보: 번호 ABC-123 \(2개\)<\/h3>/);
  const table = rows(body);
  const keeper = outcome.result.groups[0].keep.path;
  for (const cells of table.slice(0, 2)) {
    if (path.join(dir, cells[0]) === keeper) assert.match(cells[1], /남길 파일/);
    else assert.match(cells[1], /지울 후보/);
  }
  assert.strictEqual(table.filter((cells) => /남길 파일/.test(cells[1])).length, 1);

  const film = (name, extra) => ({ path: p(name), size: 1000, duration: 60, width: 1920, height: 1080, displayWidth: 1920, displayHeight: 1080, note: null, ...extra });
  const synthetic = toPlain({
    command: 'find-duplicates',
    result: {
      target: T,
      groups: [{ kind: 'name', key: 'img', number: null, part: null, generic: true, differentTitles: false, files: [film('IMG_1.mp4'), film('img_1.mov')], keep: { path: p('IMG_1.mp4'), reason: '해상도가 큼', doubt: null } }],
      metadataGroups: [
        { aspect: '16:9', duration: 3725, sameSize: true, alsoNamed: false, files: [film('x.mp4'), film('y.mkv')], keep: { path: p('y.mkv'), reason: '경로 순', doubt: '길이가 서로 달라 같은 영상이 아닐 수 있습니다.' } },
        { aspect: '16:9', duration: 60, sameSize: false, alsoNamed: true, files: [film('IMG_1.mp4'), film('img_1.mov')], keep: { path: p('IMG_1.mp4'), reason: '', doubt: null } },
      ],
      unknownMetadata: 1,
      metadataErrors: [],
      conflicts: [{ path: p('A-1 B-2.mp4'), numbers: ['A-1', 'B-2'] }],
      unreadable: [],
      skipped: [],
      checked: 5,
    },
  });
  const view = String(findDuplicatesView(synthetic));
  assert.match(view, /흔한 이름이라/);
  assert.match(view, /<h3>길이가 같은 영상: 1:02:05, 화면 비율 16:9, 크기도 같음 \(2개\)<\/h3>/);
  assert.match(view, /alert-warning[^>]*>길이가 서로 달라/);
  // alsoNamed 묶음은 이름 묶음과 같아 되풀이하지 않는다.
  assert.strictEqual((view.match(/<h3>/g) ?? []).length, 2);
  assert.match(view, /<td>A-1 B-2\.mp4<\/td><td><span class="badge badge-skip">번호가 여럿<\/span><\/td><td>번호가 여럿: A-1, B-2<\/td>/);
});

test('find-low-quality 화면: 기준과 해상도·비트레이트 열을 보인다 (#259)', () => {
  const outcome = toPlain({
    command: 'find-low-quality',
    result: {
      target: T,
      criteria: { minHeight: 480, minBitrate: 1000 },
      low: [{ path: p('s.mp4'), size: 2048, width: 640, height: 352, displayWidth: 626, displayHeight: 352, duration: 61.4, bitrate: 812_345, reasons: ['짧은 쪽 352화소', '비트레이트 812kbps'], byResolution: true }],
      unreadable: [{ path: p('a.avi'), reason: '.avi 형식은 해상도를 읽지 못합니다.' }],
      skipped: [],
      checked: 2,
    },
  });
  const body = String(findLowQualityView(outcome));
  assert.match(body, /기준: 화면의 짧은 쪽 480화소 또는 비트레이트 1000kbps 미만/);
  const [first] = rows(body);
  assert.deepStrictEqual(first.slice(0, 4), ['s.mp4', '640x352 (보이는 크기 626x352)', '812kbps', '1:01']);
  assert.match(first[4], /^2(\.0)? ?KB$/);
  assert.strictEqual(first[5], '짧은 쪽 352화소, 비트레이트 812kbps');
  assert.match(body, /<td>a\.avi<\/td><td><span class="badge badge-warning">판단 못함/);
});

test('remove-broken 화면: 미리보기는 지울 목록, 확인값이 다르면 오류, 지운 뒤에는 휴지통과 기록 위치를 보인다 (#259)', () => {
  const base = { target: T, broken: [], suspect: [{ path: p('s.zip'), size: 1, reason: '의심' }], unreadable: [], skipped: [], checked: 3, interactive: null, code: 'abc123', confirmed: false, mismatch: false, removed: [], failed: [], log: null };
  const removal = { path: p('b.zip'), size: 4096, reason: '잘림', stamp: '1' };
  const kept = { path: p('new.zip'), reason: '방금 바뀐 파일이라 받는 중일 수 있어 남겼습니다.' };

  const preview = String(removeView(toPlain({ command: 'remove-broken', result: { ...base, dryRun: true, removals: [removal], kept: [kept] } })));
  assert.match(preview, /alert-info[^>]*>아직 지우지 않았습니다\. 아래 1개를 확인한 뒤 실행하면 휴지통으로 보냅니다\./);
  const table = rows(preview);
  assert.deepStrictEqual(table[0].slice(0, 1), ['b.zip']);
  assert.match(table[0][1], /지울 파일/);
  assert.strictEqual(table[0][3], '잘림');
  assert.match(table[1][1], /남김/);
  assert.strictEqual(table[1][3], kept.reason);
  assert.match(preview, /<td>s\.zip<\/td><td><span class="badge badge-warning">의심\(지우지 않음\)/);
  assert.doesNotMatch(preview, /제거 기록/);

  const mismatch = String(removeView(toPlain({ command: 'remove-broken', result: { ...base, removals: [removal], kept: [], mismatch: true } })));
  assert.match(mismatch, /alert-error[^>]*>목록이 확인값을 만든 때와 달라 아무것도 지우지 않았습니다/);

  const logPath = p('fctl-removed-1.json');
  const done = String(removeView(toPlain({ command: 'remove-broken', result: { ...base, removals: [removal, { ...removal, path: p('c.zip') }], kept: [], confirmed: true, removed: [removal], failed: [{ path: p('c.zip'), reason: '사용 중' }], log: logPath } })));
  assert.match(done, /alert-warning[^>]*>휴지통으로 1개를 보냈습니다\. 실패 1개\./);
  assert.deepStrictEqual(rows(done).map((cells) => cells[0]), ['b.zip', 'c.zip', 's.zip']);
  assert.match(rows(done)[0][1], /휴지통으로 보냄/);
  assert.match(rows(done)[1][1], /badge-error">실패/);
  assert.ok(done.includes(`제거 기록: <code>${logPath}</code>`));
});

test('remove-duplicates·remove-low-quality 화면: 묶음 열과 남길 파일, 기준을 보인다 (#259)', () => {
  const film = (name) => ({ path: p(name), size: 1000, duration: 60, width: 1920, height: 1080, displayWidth: 1920, displayHeight: 1080 });
  const dup = String(removeView(toPlain({
    command: 'remove-duplicates',
    result: {
      target: T, groups: [], metadataGroups: [], conflicts: [], unreadable: [], skipped: [], checked: 3, lengthOnly: 2, interactive: null, code: 'c', dryRun: true, confirmed: false, mismatch: false, removed: [], failed: [], log: null,
      sets: [{ label: '번호 ABC-123', keep: { ...film('ABC-123.mp4'), reason: '해상도가 큼' }, doubt: '길이가 서로 달라 같은 영상이 아닐 수 있습니다.' }],
      removals: [{ ...film('ABC-123 (2).mp4'), set: 0, keep: p('ABC-123.mp4'), reason: '' }],
      kept: [{ path: p('ABC-123 hard.mp4'), set: 0, reason: '남길 파일과 같은 파일(하드링크)이라 남겼습니다.', file: film('ABC-123 hard.mp4') }],
    },
  })));
  const table = rows(dup);
  assert.strictEqual(table[0].length, 5);
  assert.strictEqual(table[0][4], '번호 ABC-123 (남길 파일 ABC-123.mp4)');
  assert.match(table[1][3], /하드링크/);
  assert.match(dup, /번호 ABC-123: 길이가 서로 달라/);
  assert.match(dup, /길이만 같은 묶음 2개는/);

  const low = String(removeView(toPlain({
    command: 'remove-low-quality',
    result: {
      target: T, criteria: { minHeight: 360, minBitrate: null }, low: [], unreadable: [], skipped: [], checked: 1, interactive: null, code: 'c', dryRun: false, confirmed: false, mismatch: false, removed: [], failed: [], log: null, kept: [],
      removals: [{ ...film('tiny.mp4'), width: 320, height: 240, displayWidth: 320, displayHeight: 240, bitrate: 300_000, reasons: ['짧은 쪽 240화소'] }],
    },
  })));
  assert.match(low, /기준: 화면의 짧은 쪽 360화소 미만/);
  assert.match(rows(low)[0][2], /^320x240, 300kbps, 1:00, /);
  assert.strictEqual(rows(low)[0][3], '짧은 쪽 240화소');
  assert.strictEqual(rows(low)[0].length, 4);
});

test('지울 파일이 없으면 안내를 보인다 (#259)', () => {
  const dir = tempDir();
  const body = String(removeView(run(['remove-broken', dir])));
  assert.match(body, /alert-info[^>]*>지울 파일이 없습니다\./);
  assert.match(body, /지울 파일도 남긴 파일도 없습니다\./);
});

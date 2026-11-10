'use strict';

// 미리보기 → 실행 공통 흐름의 판정 부분(#255).

const test = require('node:test');
const assert = require('node:assert');
const { canonical, fingerprint, decideExecution, dangerConfirmations, orderResults, countResults, resultSection } = require('../src/ui/flow');

const preview = { target: 'C:\\t', dryRun: true, moved: [{ from: 'C:\\t\\a\\x.mp4', to: 'C:\\t\\x.mp4' }], skipped: [] };
const base = { command: 'flatten', args: ['C:\\t'], options: {}, preview };

test('canonical은 키 순서·Set·Map·Error·bigint를 늘 같은 JSON 값으로 바꾼다 (#255)', () => {
  assert.deepStrictEqual(canonical({ b: 1, a: new Set(['y', 'x']), c: new Map([['k', 1n]]), e: new Error('잠김'), u: undefined }), { a: ['x', 'y'], b: 1, c: { k: '1' }, e: { error: '잠김' } });
  assert.strictEqual(JSON.stringify(canonical({ b: 1, a: 2 })), JSON.stringify(canonical({ a: 2, b: 1 })));
});

test('fingerprint는 명령·인자·옵션·미리보기 결과가 같으면 같고 하나라도 다르면 다르다 (#255)', () => {
  const same = fingerprint(base);
  assert.match(same, /^[0-9a-f]{64}$/);
  assert.strictEqual(fingerprint({ ...base, preview: JSON.parse(JSON.stringify(preview)) }), same);
  assert.notStrictEqual(fingerprint({ ...base, args: ['C:\\u'] }), same);
  assert.notStrictEqual(fingerprint({ ...base, options: { force: true } }), same);
  assert.notStrictEqual(fingerprint({ ...base, command: 'collapse' }), same);
  assert.notStrictEqual(fingerprint({ ...base, preview: { ...preview, moved: [] } }), same);
  // 매번 달라지는 값은 빼고 비교할 수 있다.
  assert.strictEqual(fingerprint({ ...base, preview: { ...preview, elapsed: 1 } }, { volatile: ['elapsed'] }), fingerprint({ ...base, preview: { ...preview, elapsed: 2 } }, { volatile: ['elapsed'] }));
});

test('decideExecution: 미리보기 없이 온 요청은 실행하지 않는다 (#255)', () => {
  const fresh = fingerprint(base);
  for (const form of [{}, { fingerprint: '' }, { fingerprint: 'abc' }, { fingerprint: fresh.toUpperCase() }, { fingerprint: ['x'] }]) {
    const decision = decideExecution(form, fresh);
    assert.strictEqual(decision.action, 'reject', JSON.stringify(form));
    assert.match(decision.reason, /미리보기를 거치지 않은/);
  }
});

test('decideExecution: 지문이 다르면(미리보기 뒤에 폴더가 바뀜) 새 미리보기로, 같으면 실행 (#255)', () => {
  const old = fingerprint(base);
  const fresh = fingerprint({ ...base, preview: { ...preview, moved: [] } });
  assert.deepStrictEqual(decideExecution({ fingerprint: old }, fresh), { action: 'repreview', reason: '미리보기 뒤에 폴더 내용이 바뀌어 실행하지 않았습니다. 새 미리보기를 확인한 뒤 다시 실행하세요.' });
  assert.deepStrictEqual(decideExecution({ fingerprint: old }, old), { action: 'execute' });
});

test('decideExecution: 덮어쓰기·영구 삭제를 켜고 한 번 더 확인하지 않으면 실행하지 않는다 (#255)', () => {
  const fresh = fingerprint(base);
  for (const name of ['force', 'permanent']) {
    for (const confirm of [undefined, '', 'no', 'on']) {
      const decision = decideExecution({ fingerprint: fresh, [name]: 'on', [`confirm-${name}`]: confirm }, fresh);
      assert.strictEqual(decision.action, 'reject', `${name} ${confirm}`);
      assert.match(decision.reason, /한 번 더 확인하지 않아/);
    }
    assert.strictEqual(decideExecution({ fingerprint: fresh, [name]: 'on', [`confirm-${name}`]: 'yes' }, fresh).action, 'execute');
  }
  // 확인이 없으면 지문이 달라도 먼저 거부한다(위험 옵션을 그대로 새 미리보기로 넘기지 않는다).
  assert.strictEqual(decideExecution({ fingerprint: fresh, permanent: 'on' }, fingerprint({ ...base, command: 'x' })).action, 'reject');
});

test('dangerConfirmations: 켠 위험 옵션만 경고와 필수 확인 칸을 만든다 (#255)', () => {
  assert.deepStrictEqual(dangerConfirmations({}), []);
  const out = dangerConfirmations({ permanent: 'on' }).map(String).join('');
  assert.ok(out.includes('name="confirm-permanent" value="yes" required'));
  assert.ok(out.includes('휴지통을 거치지 않고 영구 삭제합니다'));
  assert.ok(!out.includes('confirm-force'));
});

test('결과: 실패와 건너뜀을 위에 두고, 요약 카드에 이동·건너뜀·실패 수와 사유를 보여 준다 (#255)', () => {
  const items = [
    { status: 'moved', path: 'C:\\t\\a.mp4' },
    { status: 'failed', path: 'C:\\t\\<b>.mp4', reason: '사용 중 & 잠김' },
    { status: 'moved', path: 'C:\\t\\c.mp4' },
    { status: 'skipped', path: 'C:\\t\\d.mp4', reason: '같은 이름이 있음' },
  ];
  assert.deepStrictEqual(orderResults(items).map((item) => item.path), ['C:\\t\\<b>.mp4', 'C:\\t\\d.mp4', 'C:\\t\\a.mp4', 'C:\\t\\c.mp4']);
  assert.deepStrictEqual(countResults(items), { done: 2, skipped: 1, failed: 1 });
  const out = String(resultSection(items, { doneLabel: '휴지통으로 보냄' }));
  assert.ok(out.includes('<div class="card card-ok"><div class="value">2</div><div class="label">휴지통으로 보냄</div></div>'));
  assert.ok(out.includes('<div class="card card-error"><div class="value">1</div><div class="label">실패</div></div>'));
  assert.ok(out.includes('C:\\t\\&lt;b&gt;.mp4') && out.includes('사용 중 &amp; 잠김'));
  assert.ok(out.indexOf('&lt;b&gt;') < out.indexOf('d.mp4') && out.indexOf('d.mp4') < out.indexOf('a.mp4'));
});

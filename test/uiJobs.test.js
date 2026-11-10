'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execute } = require('../src/execute');
const { toPlain } = require('../src/ui/serialize');
const { runOnce } = require('../src/ui/worker');
const { createJobs, BusyError } = require('../src/ui/jobs');
const fc = require('../src/commands');
const { run } = require('../bin/fctl');

const FAKE_WORKER = path.join(__dirname, 'fakeUiWorker.js');

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-uijobs-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 작업이 끝날 때까지(running()이 비고 상태가 바뀔 때까지) 기다린다.
async function settled(jobs, job, timeoutMs = 20000) {
  const until = Date.now() + timeoutMs;
  while (job.status === 'running' || jobs.running() === job) {
    if (Date.now() > until) throw new Error(`작업이 끝나지 않음: ${job.argv.join(' ')}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return job;
}

test('toPlain은 Error·Set·Map·Buffer·BigInt를 JSON으로 옮길 수 있게 바꾼다', () => {
  const err = Object.assign(new fc.FcError('실패'), { code: 'EPERM', stderr: Buffer.from('자세한 사유'), output: '보고' });
  const value = {
    err,
    names: new Set(['a', 'b']),
    sizes: new Map([['x', 1n]]),
    list: [undefined, () => {}, NaN, Infinity],
    when: new Date(Date.UTC(2026, 0, 2)),
    skip: undefined,
  };
  const plain = toPlain(value);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(plain)), plain);
  assert.deepStrictEqual(plain.err, { name: 'FcError', message: '실패', code: 'EPERM', stderr: '자세한 사유', output: '보고' });
  assert.deepStrictEqual(plain.names, ['a', 'b']);
  assert.deepStrictEqual(plain.sizes, [['x', '1']]);
  assert.deepStrictEqual(plain.list, [null, null, 'NaN', 'Infinity']);
  assert.strictEqual(plain.when, '2026-01-02T00:00:00.000Z');
  assert.ok(!('skip' in plain));
});

test('toPlain은 순환은 끊고, 여러 곳에서 함께 쓰는 객체는 그대로 옮긴다', () => {
  const shared = { n: 1 };
  const loop = { shared, again: shared };
  loop.self = loop;
  assert.deepStrictEqual(toPlain(loop), { shared: { n: 1 }, again: { n: 1 }, self: '[순환]' });
});

test('execute는 도움말·결과·부분 실패를 던지지 않고 돌려주고, 모르는 명령은 표시해 던진다', () => {
  const dir = tempDir();
  assert.deepStrictEqual(execute([]), { help: true });
  assert.deepStrictEqual(execute(['ls', '--help']), { help: true });

  fs.writeFileSync(path.join(dir, 'a.txt'), 'A');
  const listed = execute(['ls', dir]);
  assert.strictEqual(listed.command, 'ls');
  assert.deepStrictEqual(listed.result.map((e) => e.name), ['a.txt']);
  assert.match(listed.report, /a\.txt/);
  assert.strictEqual(listed.failure, undefined);

  assert.throws(() => execute(['nope']), (err) => err instanceof fc.FcError && err.unknownCommand === true && !/사용법/.test(err.message));
  assert.throws(() => execute(['ls', '--nope']), /알 수 없는 옵션: --nope/);
});

test('execute는 지우기 명령의 확인값이 다르면 결과와 함께 failure를 돌려주고, CLI는 같은 실패로 끝난다', (t) => {
  // 임시 폴더는 사용자 설정 폴더(AppData) 아래라 보호 경로다. 다른 테스트처럼 사용자 폴더를 없는 곳으로 둔다.
  t.mock.method(os, 'homedir', () => path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home'));
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'bad.zip'), 'not a zip');
  const outcome = execute(['remove-broken', dir, '--yes=틀린값']);
  assert.strictEqual(outcome.command, 'remove-broken');
  assert.strictEqual(outcome.result.mismatch, true);
  assert.match(outcome.report, /의심, 지우지 않음: bad\.zip/);
  assert.ok(outcome.failure instanceof fc.FcError);
  assert.match(outcome.failure.message, /확인값을 만든 때와 달라/);
  assert.strictEqual(outcome.failure.output, outcome.report);
  assert.throws(() => run(['remove-broken', dir, '--yes=틀린값']), (err) => err.message === outcome.failure.message && err.output === outcome.report);
  assert.ok(fs.existsSync(path.join(dir, 'bad.zip')));
});

test('CLI run은 모르는 명령에 도움말을 붙여 거부하고, 도움말 요청에는 도움말을 돌려준다', () => {
  assert.throws(() => run(['nope']), (err) => /^알 수 없는 명령: nope\n\nfctl - 파일 컨트롤/.test(err.message));
  assert.match(run([]), /^fctl - 파일 컨트롤/);
});

test('worker의 runOnce는 결과를 JSON으로 보내고, 화면에 없는 표준 입력은 기다리지 않고 거부한다', () => {
  const dir = tempDir();
  const sent = [];
  runOnce(['mkdir', path.join(dir, 'new')], (msg) => sent.push(msg));
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].type, 'done');
  assert.strictEqual(sent[0].outcome.command, 'mkdir');
  assert.ok(fs.statSync(path.join(dir, 'new')).isDirectory());

  const errors = [];
  runOnce(['write', path.join(dir, 'w.txt')], (msg) => errors.push(msg));
  assert.deepStrictEqual(errors.map((m) => m.type), ['error']);
  assert.match(errors[0].error.message, /내용을 함께 입력/);
  assert.ok(!fs.existsSync(path.join(dir, 'w.txt')));
});

test('createJobs는 실제 작업 프로세스로 명령을 실행하고 결과를 받는다', async () => {
  const dir = tempDir();
  const jobs = createJobs();
  const job = jobs.start(['mkdir', path.join(dir, 'made')]);
  assert.strictEqual(job.status, 'running');
  assert.strictEqual(jobs.running(), job);
  assert.strictEqual(jobs.get(job.id), job);
  assert.match(job.id, /^[0-9a-f]{24}$/);
  await settled(jobs, job);
  assert.strictEqual(job.status, 'done', JSON.stringify(job.error));
  assert.strictEqual(job.outcome.command, 'mkdir');
  assert.match(job.outcome.report, /made/);
  assert.ok(fs.statSync(path.join(dir, 'made')).isDirectory());
  assert.strictEqual(jobs.running(), null);
  assert.ok(jobs.elapsed(job) >= 0);

  // 인자 오류는 error 상태로 사유를 남긴다.
  const bad = jobs.start(['flatten']);
  await settled(jobs, bad);
  assert.strictEqual(bad.status, 'error');
  assert.match(bad.error.message, /사용법: fctl flatten <타겟>/);
});

test('createJobs는 결과 객체를 JSON으로 옮겨 받고, env를 작업 프로세스에 넘긴다', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'bad.zip'), 'not a zip');
  // 임시 폴더는 AppData 아래라 보호 경로다. 작업 프로세스의 사용자 폴더를 없는 곳으로 둔다.
  const home = path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home');
  const jobs = createJobs({ env: { ...process.env, USERPROFILE: home, HOME: home } });
  const job = jobs.start(['find-broken', dir]);
  await settled(jobs, job);
  assert.strictEqual(job.status, 'done', JSON.stringify(job.error));
  assert.strictEqual(job.outcome.command, 'find-broken');
  assert.match(job.outcome.report, /bad\.zip/);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(job.outcome)), job.outcome);
  assert.match(JSON.stringify(job.outcome.result), /bad\.zip/);
});

test('createJobs는 진행 줄을 차례로 모으고 끝나면 결과를 남긴다', async () => {
  const jobs = createJobs({ workerPath: FAKE_WORKER });
  const job = jobs.start(['progress', '3']);
  await settled(jobs, job);
  assert.strictEqual(job.status, 'done');
  assert.deepStrictEqual(job.lines, ['줄 1', '줄 2', '줄 3']);
  assert.deepStrictEqual(job.outcome.result, { count: 3 });
});

test('createJobs는 실행 중에는 새 작업을 거부하고, 끝나면 다시 받는다', async () => {
  const dir = tempDir();
  const flag = path.join(dir, 'go');
  const jobs = createJobs({ workerPath: FAKE_WORKER });
  const first = jobs.start(['wait', flag]);
  assert.throws(() => jobs.start(['progress', '1']), (err) => err instanceof BusyError && err instanceof fc.FcError && err.job === first && /이미 실행 중인 작업/.test(err.message));
  assert.strictEqual(jobs.running(), first);
  fs.writeFileSync(flag, '');
  await settled(jobs, first);
  assert.strictEqual(first.status, 'done');
  const second = jobs.start(['progress', '1']);
  await settled(jobs, second);
  assert.strictEqual(second.status, 'done');
});

test('createJobs는 결과 없이 끝난 작업 프로세스를 사유와 함께 error로 남기고 다음 작업을 받는다', async () => {
  const jobs = createJobs({ workerPath: FAKE_WORKER });
  const crashed = jobs.start(['crash']);
  await settled(jobs, crashed);
  assert.strictEqual(crashed.status, 'error');
  assert.match(crashed.error.message, /결과 없이 끝났습니다\(종료 코드 3\)/);
  assert.match(crashed.error.message, /망가짐/);

  const failed = jobs.start(['error']);
  await settled(jobs, failed);
  assert.strictEqual(failed.status, 'error');
  assert.strictEqual(failed.error.message, '일부러 낸 오류');
});

test('createJobs는 끝난 작업을 정해진 개수만 남긴다', async () => {
  const jobs = createJobs({ workerPath: FAKE_WORKER, keep: 2 });
  const ids = [];
  for (let i = 0; i < 4; i++) {
    const job = jobs.start(['progress', '0']);
    ids.push(job.id);
    await settled(jobs, job);
  }
  assert.deepStrictEqual(ids.map((id) => Boolean(jobs.get(id))), [false, false, true, true]);
});

test('createJobs는 작업 프로세스를 띄우지 못하면 사유를 밝혀 거부하고 다음 작업을 받는다', async () => {
  let calls = 0;
  const fork = () => {
    calls += 1;
    throw new Error('띄우기 실패');
  };
  const jobs = createJobs({ fork });
  assert.throws(() => jobs.start(['ls']), /작업 프로세스를 띄우지 못했습니다: 띄우기 실패/);
  assert.strictEqual(jobs.running(), null);
  assert.throws(() => jobs.start(['ls']), /띄우기 실패/);
  assert.strictEqual(calls, 2);
});

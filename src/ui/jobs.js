'use strict';

// UI 작업 관리(#253). 명령을 자식 프로세스(worker.js)로 실행하고 진행 줄과 결과를 모은다.
// 같은 폴더를 두 작업이 함께 바꾸지 않게 한 번에 하나만 실행한다.
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const fc = require('../commands');

const WORKER = path.join(__dirname, 'worker.js');
// 끝난 작업은 결과 페이지를 다시 볼 수 있게 몇 개만 남긴다.
const KEEP_FINISHED = 20;
// 진행 줄이 아주 많아도 메모리를 다 쓰지 않게 앞뒤 일부만 남긴다.
const MAX_LINES = 2000;
// 줄을 버릴 때도 처음 이만큼은 남긴다(무엇을 시작했는지 보이게). 결과 페이지가 생략 표시 자리로 쓴다.
const KEPT_HEAD_LINES = 100;
// 자식이 결과 없이 죽었을 때 사유로 보여 줄 표준 오류의 끝부분 길이.
const MAX_STDERR = 4000;

class BusyError extends fc.FcError {
  constructor(job) {
    super(`A job is already running: fctl ${job.argv.join(' ')}`);
    this.name = 'BusyError';
    this.job = job;
  }
}

// fork·env는 테스트에서 바꿔 넣을 수 있다(env는 작업 프로세스의 환경 변수). now는 경과 시간 계산에 쓴다.
function createJobs({ workerPath = WORKER, fork = childProcess.fork, now = Date.now, keep = KEEP_FINISHED, env = process.env } = {}) {
  const jobs = new Map();
  let active = null;

  function forget() {
    const finished = [...jobs.values()].filter((job) => job.status !== 'running');
    for (const job of finished.slice(0, Math.max(0, finished.length - keep))) jobs.delete(job.id);
  }

  // argv는 CLI와 같은 인자 배열이다. 실행 중인 작업이 있으면 BusyError를 던진다.
  function start(argv) {
    if (active) throw new BusyError(active);
    const job = {
      id: crypto.randomBytes(12).toString('hex'),
      argv: argv.map(String),
      status: 'running',
      startedAt: now(),
      endedAt: null,
      lines: [],
      droppedLines: 0,
      outcome: null,
      error: null,
    };
    let child;
    try {
      child = fork(workerPath, [], { env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    } catch (err) {
      throw new fc.FcError(`Could not start the job process: ${err.message}`);
    }
    active = job;
    jobs.set(job.id, job);

    let stderr = '';
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk).slice(-MAX_STDERR);
      });
    }
    let reply = null;
    child.on('message', (message) => {
      if (!message || job.status !== 'running') return;
      if (message.type === 'progress') addLine(job, message.line);
      else if (message.type === 'done' || message.type === 'error') reply = message;
    });
    let settled = false;
    const settle = (code, signal, spawnError) => {
      if (settled) return;
      settled = true;
      job.endedAt = now();
      if (reply && reply.type === 'done') {
        job.status = 'done';
        job.outcome = reply.outcome;
      } else if (reply && reply.type === 'error') {
        job.status = 'error';
        job.error = reply.error;
      } else {
        const reason = spawnError ? spawnError.message : signal ? `signal ${signal}` : `exit code ${code}`;
        const detail = stderr.trim() ? `\n${stderr.trim()}` : '';
        job.status = 'error';
        job.error = { name: 'FcError', message: `The job process ended without a result (${reason}).${detail}` };
      }
      if (active === job) active = null;
      forget();
    };
    // 결과 메시지를 받아도 프로세스가 끝날 때까지는 다음 작업을 받지 않는다.
    // exit는 아직 읽지 않은 메시지보다 먼저 올 수 있으므로, IPC 채널과 표준 오류까지 닫힌 뒤의 close에서 마무리한다.
    let childError = null;
    child.on('close', (code, signal) => settle(code, signal, childError));
    // error는 프로세스가 살아 있어도(메시지 보내기 실패 등) 올 수 있다. 그때 풀면 두 작업이 함께 돌 수 있으므로,
    // 띄우기 자체가 실패해 pid가 없을 때만 바로 정리하고, 그 밖에는 사유만 두고 close를 기다린다.
    child.on('error', (err) => {
      childError = err;
      if (child.pid === undefined) settle(null, null, err);
    });
    child.send({ argv: job.argv });
    return job;
  }

  return {
    start,
    get: (id) => jobs.get(id),
    running: () => active,
    elapsed: (job) => (job.endedAt ?? now()) - job.startedAt,
  };
}

function addLine(job, line) {
  job.lines.push(String(line));
  if (job.lines.length > MAX_LINES) {
    // 처음 몇 줄은 무엇을 시작했는지 보여 주므로 남기고, 그 뒤를 버린다.
    job.lines.splice(KEPT_HEAD_LINES, 1);
    job.droppedLines += 1;
  }
}

// 경과 시간을 '1시간 2분 3초'처럼 보여 준다. 1초 미만은 0초다.
function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

module.exports = { createJobs, BusyError, formatElapsed, KEPT_HEAD_LINES };

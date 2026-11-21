'use strict';

// UI job management (#253). It runs the command in a child process (worker.js) and collects the progress lines and the result.
// It runs only one at a time so that two jobs do not change the same folder together.
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const path = require('node:path');
const fc = require('../commands');

const WORKER = path.join(__dirname, 'worker.js');
// It keeps only a few finished jobs so that the result page can be viewed again.
const KEEP_FINISHED = 20;
// Even with a huge number of progress lines, it keeps only part of the front and back so as not to use up memory.
const MAX_LINES = 2000;
// Even when dropping lines, it keeps this many at the start (so you can see what was started). The result page uses it as the place of the omission mark.
const KEPT_HEAD_LINES = 100;
// The length of the end of standard error to show as the reason when the child died without a result.
const MAX_STDERR = 4000;
// How long stop() waits for the process to close before it answers anyway.
const STOP_WAIT_MS = 5000;

// It ends the child and, on Windows, the whole process tree it started (PowerShell, tar.exe and so on), which child.kill() alone would leave running.
// It does nothing once the child has exited: the pid may already belong to an unrelated process, and taskkill /T would end that tree.
// taskkill runs asynchronously so the server is not blocked. The returned promise resolves when it ends (or fails).
function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  const killed = new Promise((resolve) => {
    if (process.platform !== 'win32' || child.pid === undefined) return resolve();
    try {
      const killer = childProcess.spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', resolve);
      killer.once('close', resolve);
    } catch {
      resolve();
    }
  });
  return killed.then(() => {
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    } catch {
      // Already gone.
    }
  });
}

class BusyError extends fc.FcError {
  constructor(job) {
    super(`A job is already running: fctl ${job.argv.join(' ')}`);
    this.name = 'BusyError';
    this.job = job;
  }
}

// fork and env can be swapped in tests (env is the worker process's environment variables). now is used for the elapsed time calculation.
function createJobs({ workerPath = WORKER, fork = childProcess.fork, now = Date.now, keep = KEEP_FINISHED, env = process.env, stopWaitMs = STOP_WAIT_MS } = {}) {
  const jobs = new Map();
  let active = null;
  // The live child process and the promise of its close, per running job. Kept here (not on the job) so a job stays plain data.
  const children = new Map();

  function forget() {
    const finished = [...jobs.values()].filter((job) => job.status !== 'running');
    for (const job of finished.slice(0, Math.max(0, finished.length - keep))) jobs.delete(job.id);
  }

  // argv is the same argument array as the CLI. If a job is running, it throws BusyError.
  // mode 'preview' or 'run' (with expect, the preview fingerprint) makes the worker use the checked flow (#255). Without mode it runs argv as is.
  function start(argv, { mode, expect } = {}) {
    if (active) throw new BusyError(active);
    const job = {
      id: crypto.randomBytes(12).toString('hex'),
      argv: argv.map(String),
      mode,
      status: 'running',
      startedAt: now(),
      endedAt: null,
      lastProgressAt: null,
      stopRequested: false,
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
    let closed;
    const done = new Promise((resolve) => { closed = resolve; });
    const entry = { child, done, closed, abandon: null };
    children.set(job.id, entry);
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
      if (message.type === 'progress') {
        addLine(job, message.line);
        job.lastProgressAt = now();
      }
      else if (message.type === 'done' || message.type === 'error') reply = message;
    });
    let settled = false;
    let abandoned = false;
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
      } else if (job.stopRequested && !abandoned) {
        job.status = 'stopped';
      } else {
        const reason = spawnError ? spawnError.message : signal ? `signal ${signal}` : `exit code ${code}`;
        const detail = stderr.trim() ? `\n${stderr.trim()}` : '';
        job.status = 'error';
        job.error = { name: 'FcError', message: `The job process ended without a result (${reason}).${detail}` };
      }
      if (active === job) active = null;
      children.delete(job.id);
      entry.closed();
      forget();
    };
    // A process that ignores the kill must not keep the UI busy forever (#330): stop() calls this after its wait, which gives up on the process.
    entry.abandon = () => {
      if (settled) return;
      abandoned = true;
      childError = childError ?? new Error('the process did not end after it was told to stop');
      settle(null, null, childError);
    };
    // Even after receiving the result message, it does not accept the next job until the process ends.
    // exit can come before messages not yet read, so it finishes at close, after the IPC channel and standard error are also closed.
    let childError = null;
    child.on('close', (code, signal) => settle(code, signal, childError));
    // error can come even while the process is alive (a message send failure and so on). Releasing then could let two jobs run together, so
    // it cleans up right away only when the launch itself failed and there is no pid, and otherwise it leaves only the reason and waits for close.
    child.on('error', (err) => {
      childError = err;
      if (child.pid === undefined) settle(null, null, err);
    });
    child.send({ argv: job.argv, mode, expect });
    return job;
  }

  // It stops a running job: kills the process (tree) and waits for close, which clears the running state. It resolves to the job.
  // A job that is not running (finished, or already stopping and closed) is returned as it is.
  async function stop(job) {
    const entry = children.get(job.id);
    if (!entry || job.status !== 'running') return job;
    job.stopRequested = true;
    let timer;
    // A grandchild (tar.exe, PowerShell) can keep the piped stderr open after the worker died, so it is destroyed to let close fire.
    const killing = killTree(entry.child).then(() => { if (entry.child.stderr) entry.child.stderr.destroy(); });
    await Promise.race([Promise.all([killing, entry.done]),new Promise((resolve) => { timer = setTimeout(resolve, stopWaitMs); })]);
    clearTimeout(timer);
    if (job.status === 'running') entry.abandon();
    return job;
  }

  // It stops the running job, if any, and waits for it (used when the server shuts down, #330).
  async function stopAll() {
    if (active) await stop(active);
  }

  return {
    start,
    stop,
    stopAll,
    // Milliseconds since the last progress line (or since the start if none came yet).
    idle: (job) => (job.endedAt ?? now()) - (job.lastProgressAt ?? job.startedAt),
    get: (id) => jobs.get(id),
    running: () => active,
    elapsed: (job) => (job.endedAt ?? now()) - job.startedAt,
  };
}

function addLine(job, line) {
  job.lines.push(String(line));
  if (job.lines.length > MAX_LINES) {
    // The first few lines show what was started, so they are kept and what follows is dropped.
    job.lines.splice(KEPT_HEAD_LINES, 1);
    job.droppedLines += 1;
  }
}

// It shows the elapsed time like "1h 2m 3s". Under 1 second is "0s".
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

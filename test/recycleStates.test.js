'use strict';

// rm checks the Recycle Bin state of all its targets in one PowerShell run, and still reports problems target by target (#376).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { withConfig } = require('./withConfig');
const fc = require('../src/commands');

const isWindows = process.platform === 'win32';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-states-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A fake PowerShell: it counts the state runs (one path in FC_VOLUME, several in FC_VOLUMES) and the moves (FC_TARGET).
// stateFor(path) gives the answer line of one path.
function fakePowerShell(t, stateFor = () => 'True|Fixed||') {
  const calls = { single: [], many: [], moves: [] };
  t.mock.method(childProcess, 'execFileSync', (file, args, options) => {
    const env = options?.env ?? {};
    if (env.FC_VOLUME !== undefined) {
      calls.single.push(env.FC_VOLUME);
      return `${stateFor(env.FC_VOLUME)}\r\n`;
    }
    if (env.FC_VOLUMES !== undefined) {
      const paths = env.FC_VOLUMES.split('|');
      calls.many.push(paths);
      assert.match(args.at(-1), /FC_VOLUMES/);
      return `${paths.map(stateFor).join('\r\n')}\r\n`;
    }
    if (env.FC_TARGET !== undefined) {
      calls.moves.push(env.FC_TARGET);
      fs.rmSync(env.FC_TARGET, { recursive: true });
      return '';
    }
    throw new Error(`unexpected call: ${file}`);
  });
  return calls;
}

function files(t, names) {
  const dir = tempDir(t);
  return names.map((name) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, 'x');
    return file;
  });
}

test('rm of three targets reads the state in one run, then moves each one', { skip: !isWindows && 'Windows Recycle Bin' }, (t) => {
  const [a, b, c] = files(t, ['a.txt', 'b.txt', 'c.txt']);
  const calls = fakePowerShell(t);
  fc.remove([a, b, c], { permanentHint: true });
  assert.strictEqual(calls.single.length, 0);
  assert.strictEqual(calls.many.length, 1);
  assert.deepStrictEqual(calls.many[0], [a, b, c].map((p) => path.resolve(p)));
  assert.strictEqual(calls.moves.length, 3);
  assert.ok(![a, b, c].some((p) => fs.existsSync(p)));
});

test('rm of one target still uses the one-path state run (the shape the other callers use)', { skip: !isWindows && 'Windows Recycle Bin' }, (t) => {
  const [a] = files(t, ['a.txt']);
  const calls = fakePowerShell(t);
  fc.remove([a]);
  assert.strictEqual(calls.single.length, 1);
  assert.strictEqual(calls.many.length, 0);
});

test('every target keeps its own state: a target on a volume that removes files immediately is refused and nothing is deleted', { skip: !isWindows && 'Windows Recycle Bin' }, (t) => {
  const [a, b, c] = files(t, ['a.txt', 'b.txt', 'c.txt']);
  // The second target stands for a volume mount folder with the remove-immediately setting; the drive root alone would not tell.
  const calls = fakePowerShell(t, (p) => (p === path.resolve(b) ? 'True|Fixed|1|' : 'True|Fixed||'));
  assert.throws(() => fc.remove([a, b, c]), (err) => err instanceof fc.FcError && err.message.includes(path.resolve(b)) && /remove files immediately/.test(err.message));
  assert.strictEqual(calls.moves.length, 0);
  assert.ok([a, b, c].every((p) => fs.existsSync(p)));
  assert.strictEqual(calls.many.length, 1);
});

test('the dry run reads the state in one run and moves nothing', { skip: !isWindows && 'Windows Recycle Bin' }, (t) => {
  const [a, b] = files(t, ['a.txt', 'b.txt']);
  const calls = fakePowerShell(t);
  const lines = fc.remove([a, b], { dryRun: true });
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(calls.many.length, 1);
  assert.strictEqual(calls.moves.length, 0);
});

test('the first problem in target order is still the one reported', { skip: !isWindows && 'Windows Recycle Bin' }, (t) => {
  const [a, b] = files(t, ['a.txt', 'b.txt']);
  const missing = path.join(path.dirname(a), 'missing.txt');
  // a is refused by the volume setting and the later target does not exist: the volume refusal of the earlier target comes first, as before.
  let calls = fakePowerShell(t, () => 'True|Fixed|1|');
  assert.throws(() => fc.remove([a, missing]), /remove files immediately/);
  assert.strictEqual(calls.many.length + calls.single.length, 1);
  t.mock.reset();
  // A validation error in the first target is reported before any state is read for the later ones.
  calls = fakePowerShell(t, () => 'True|Fixed|1|');
  assert.throws(() => fc.remove([missing, b]), /does not exist|Cannot find|not found/i);
  assert.strictEqual(calls.many.length + calls.single.length, 0);
  assert.ok(fs.existsSync(a) && fs.existsSync(b));
});

test('recycleBinStates gives the unknown state for every target when the run fails or an answer line is missing', { skip: !isWindows && 'Windows Recycle Bin' }, (t) => {
  const [a, b, c] = files(t, ['a.txt', 'b.txt', 'c.txt']);
  t.mock.method(childProcess, 'execFileSync', (file, args, options) => {
    if (options?.env?.FC_VOLUMES !== undefined) return 'True|Fixed||\r\n';
    throw new Error('unexpected');
  });
  const states = fc.recycleBinStates([a, b, c]);
  assert.strictEqual(states[0].driveType, 'Fixed');
  assert.strictEqual(states[1].driveType, null);
  assert.strictEqual(states[2].driveType, null);
  t.mock.reset();
  t.mock.method(childProcess, 'execFileSync', () => {
    throw new Error('PowerShell failed');
  });
  assert.ok(fc.recycleBinStates([a, b]).every((state) => state.driveType === null && state.interactive === null));
  assert.deepStrictEqual(fc.recycleBinStates([]), []);
});

test('recycleBinStates is unknown for every target when the platform is not Windows', (t) => {
  withConfig(t, { isWindows: false });
  assert.deepStrictEqual(fc.recycleBinStates(['/a', '/b']).map((state) => state.driveType), [null, null]);
});

test('the real state script answers each path of a batch the same as the one-path run', { skip: !isWindows && 'Windows PowerShell' }, () => {
  const paths = [os.tmpdir(), process.env.SystemRoot || 'C:\\Windows', process.cwd()];
  assert.deepStrictEqual(fc.recycleBinStates(paths), paths.map((p) => fc.recycleBinState(p)));
});

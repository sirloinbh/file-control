'use strict';

// run (#400): a saved recipe of whole-target commands. The recipe is checked before any step runs, steps run in order and stop at the first failure,
// --dry-run previews every step, and a recipe can never confirm, overwrite or permanently delete.

const test = require('node:test');
const assert = require('node:assert');
const childProcess = require('node:child_process');
const { volumeStateAnswer } = require('./volumeState');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The temp folder is under the user's AppData, a protected path, so the user folder is swapped with a path that does not exist.
test.mock.method(os, 'homedir', () => path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home'));

// The volume checks of a remove preview are answered here, and nothing can reach the real Recycle Bin.
const realExecFileSync = childProcess.execFileSync;
const recycled = [];
test.mock.method(childProcess, 'execFileSync', (file, args, options) => {
  if (options?.env?.FC_FORMAT_VOLUME !== undefined) return 'NTFS\r\n';
  const state = volumeStateAnswer(options?.env, () => 'True|Fixed\r\n');
  if (state !== undefined) return state;
  // flatten sends the folders it emptied to the Recycle Bin in one batch (#67): this imitates it by deleting those empty folders in the temp folder.
  if (options?.env?.FC_BATCH !== undefined) {
    const lines = [];
    for (const line of options.input.split('\n').filter(Boolean)) {
      const folder = Buffer.from(line, 'base64').toString('utf16le');
      const filled = fs.readdirSync(folder, { recursive: true, withFileTypes: true }).some((entry) => !entry.isDirectory());
      if (!filled) fs.rmSync(folder, { recursive: true });
      lines.push(`${filled ? 'filled' : 'ok'} ${line}`);
    }
    return lines.join('\r\n') + '\r\n';
  }
  if (options?.env?.FC_RECYCLE_FILES !== undefined || options?.env?.FC_TARGET !== undefined) {
    recycled.push(options.input ?? options.env.FC_TARGET);
    throw new Error('A recipe test must not send anything to the Recycle Bin.');
  }
  return realExecFileSync(file, args, options);
});

// Files made just now are protected from removal, so the clock is moved forward 1 hour.
const HOUR = 60 * 60 * 1000;
const realNow = Date.now;
test.mock.method(Date, 'now', () => realNow() + HOUR);

const { runRecipe, formatRecipe, validateRecipe, loadRecipe } = require('../src/recipe');
const { execute } = require('../src/execute');
const { run } = require('../bin/fctl');

const OLD = new Date(realNow() - HOUR);

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-recipe-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return fs.realpathSync.native(dir);
}

function make(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    fs.utimesSync(full, OLD, OLD);
  }
}

// The recipe goes in its own folder so it is not part of the target.
function recipeFile(recipe) {
  const dir = tempDir();
  const file = path.join(dir, 'recipe.json');
  fs.writeFileSync(file, typeof recipe === 'string' ? recipe : JSON.stringify(recipe));
  return file;
}

const listing = (dir) => fs.readdirSync(dir, { recursive: true }).map((name) => name.split(path.sep).join('/')).sort();

test.beforeEach(() => {
  recycled.length = 0;
});

test('a recipe of flatten then normalize runs both on a temp folder', () => {
  const dir = tempDir();
  make(dir, { 'sub/movie ABC-123.mp4': 'one', 'sub/deeper/notes.txt': 'two' });
  const file = recipeFile({ name: 'tidy', steps: [{ command: 'flatten' }, 'normalize'] });
  const output = run(['run', file, dir]);
  const names = listing(dir);
  assert.ok(!names.includes('sub/movie ABC-123.mp4'), 'flatten moved the file out of sub');
  assert.ok(names.includes('notes.txt'));
  assert.ok(names.some((name) => /^ABC-123/.test(name)), `normalize put the product number first: ${names.join(', ')}`);
  assert.match(output, /^Recipe "tidy": 2 steps on /);
  assert.match(output, /Step 1\/2: flatten\n/);
  assert.match(output, /Step 2\/2: normalize\n/);
  assert.match(output, /All 2 steps finished\.$/);
});

test('--dry-run previews every step and changes nothing', () => {
  const dir = tempDir();
  make(dir, { 'sub/movie ABC-123.mp4': 'one' });
  const before = listing(dir);
  const file = recipeFile({ steps: ['flatten', 'normalize'] });
  const output = run(['run', file, dir, '--dry-run']);
  assert.deepStrictEqual(listing(dir), before);
  assert.match(output, /\(dry run: nothing is changed\)/);
  assert.match(output, /All 2 steps finished\./);
  const seen = [];
  runRecipe(file, dir, { dryRun: true, execute: (argv) => { seen.push(argv); return { report: '' }; } });
  assert.deepStrictEqual(seen.map((argv) => argv.slice(0, 2)), [['flatten', '--dry-run'], ['normalize', '--dry-run']]);
});

test('an invalid recipe is rejected before any step runs', () => {
  const dir = tempDir();
  make(dir, { 'sub/a.txt': 'x' });
  const before = listing(dir);
  const bad = [
    ['not json {', /not valid JSON/],
    ['[]', /must be a JSON object/],
    [{}, /non-empty "steps"/],
    [{ steps: [] }, /non-empty "steps"/],
    [{ steps: 'flatten' }, /non-empty "steps"/],
    [{ steps: ['flatten'], extra: 1 }, /unknown field "extra"/],
    [{ name: 5, steps: ['flatten'] }, /"name" must be text/],
    [{ steps: ['flatten', 'nonsense'] }, /Step 2 \(nonsense\): "nonsense" cannot be a step/],
    [{ steps: ['flatten', 'rm'] }, /Step 2 \(rm\): "rm" cannot be a step/],
    [{ steps: ['run'] }, /cannot run another recipe/],
    [{ steps: ['ui'] }, /cannot be a step/],
    [{ steps: [42] }, /Step 1: a step is a command name/],
    [{ steps: [{ command: 'flatten', extra: 1 }] }, /unknown field "extra"/],
    [{ steps: [{ command: 'flatten', options: '--x' }] }, /"options" must be a list of strings/],
    [{ steps: [{ command: 'flatten', options: ['nope'] }] }, /"nope" is not an option/],
    [{ steps: [{ command: 'flatten', options: ['--bogus'] }] }, /unknown option --bogus/],
    [{ steps: [{ command: 'flatten', options: ['--include-lowercase'] }] }, /--include-lowercase can be used only with normalize/],
    [{ steps: [{ command: 'find', options: ['--larger'] }] }, /attach a value to --larger/],
    [{ steps: [{ command: 'normalize', options: ['--include-lowercase=1'] }] }, /does not take a value/],
    [{ steps: ['flatten', { command: 'remove-duplicates' }, 'normalize'] }, /Step 2 \(remove-duplicates\) only shows a list and a confirmation value, so it must be the last step/],
  ];
  for (const [recipe, pattern] of bad) {
    const file = recipeFile(recipe);
    let ran = 0;
    assert.throws(() => runRecipe(file, dir, { execute: () => { ran += 1; return { report: '' }; } }), pattern, JSON.stringify(recipe));
    assert.strictEqual(ran, 0, `no step ran for ${JSON.stringify(recipe)}`);
    assert.throws(() => run(['run', file, dir]), pattern);
  }
  assert.deepStrictEqual(listing(dir), before);
  assert.throws(() => loadRecipe(path.join(dir, 'missing.json')), /Cannot read the recipe file/);
  assert.throws(() => loadRecipe(dir), /not a file/);
});

test('a recipe can never confirm, overwrite, delete permanently or dry-run on its own', () => {
  for (const option of ['--yes', '--yes=abc123', '--force', '--permanent', '--dry-run', '--help']) {
    const name = option.slice(2).split('=')[0];
    assert.throws(
      () => validateRecipe({ steps: [{ command: 'remove-broken', options: [option] }] }),
      new RegExp(`--${name} cannot be used in a recipe`),
      option,
    );
  }
});

test('every spelling of a forbidden option is refused, and odd keys and sizes are rejected', () => {
  const step = (option) => ({ steps: [{ command: 'normalize', options: [option] }] });
  for (const option of ['--yes', '--YES', '--yes=1', '--yes ', ' --yes', '--yes\n', '--force', '--permanent', '--remove-archives']) {
    assert.throws(() => validateRecipe(step(option)), /cannot be used in a recipe|is not an option/, JSON.stringify(option));
  }
  assert.throws(() => validateRecipe({ steps: [{ command: 'extract-all', options: ['--remove-archives'] }] }), /--remove-archives cannot be used in a recipe/);
  // A value that contains = or -- stays one value and cannot add an option.
  assert.deepStrictEqual(validateRecipe({ steps: [{ command: 'find', options: ['--ext=--yes=1'] }] }).steps[0].options, ['--ext=--yes=1']);
  assert.throws(() => validateRecipe({ steps: [{ command: 'find', options: ['--ext=a --yes'] , x: 1 }] }), /unknown field "x"/);
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    assert.throws(() => validateRecipe(JSON.parse(`{"steps":["flatten"],"${key}":{}}`)), /unknown field/, key);
    assert.throws(() => validateRecipe(JSON.parse(`{"steps":[{"command":"flatten","${key}":{}}]}`)), /unknown field/, key);
  }
  for (const command of ['Flatten', ' flatten', 'flatten ', 'FLATTEN']) assert.throws(() => validateRecipe({ steps: [command] }), /cannot be a step/, JSON.stringify(command));
  assert.throws(() => validateRecipe({ steps: Array(51).fill('flatten') }), /at most 50 are allowed/);
  assert.strictEqual(validateRecipe({ steps: Array(50).fill('flatten') }).steps.length, 50);
  const big = recipeFile(JSON.stringify({ steps: ['flatten'], name: 'x'.repeat(1024 * 1024 + 1) }));
  assert.throws(() => loadRecipe(big), /too large/);
});

test('the target comes after -- so a target that looks like an option cannot become one', () => {
  const dir = tempDir();
  const seen = [];
  const file = recipeFile({ steps: [{ command: 'find', options: ['--ext=txt'] }, 'du'] });
  runRecipe(file, '--yes=1', { dryRun: true, execute: (argv) => { seen.push(argv); return { report: '' }; } });
  assert.deepStrictEqual(seen, [['find', '--ext=txt', '--dry-run', '--', '--yes=1'], ['du', '--dry-run', '--', '--yes=1']]);
  // On the command line it is refused as the option it looks like; after -- it is a target, and the step refuses it as a missing folder.
  assert.throws(() => run(['run', file, '--yes=1']), /--yes can be used only with/);
  assert.throws(() => run(['run', file, '--', '--yes=1']), /does not exist/);
  assert.ok(dir);
});

test('an unexpected error of a step is rethrown and the journal run is closed', () => {
  const dir = tempDir();
  make(dir, { 'a.txt': 'x' });
  const journal = require('../src/journal');
  const file = recipeFile({ steps: ['flatten', 'normalize'] });
  const boom = new TypeError('programming error');
  assert.throws(() => runRecipe(file, dir, { execute: () => { throw boom; } }), (err) => err === boom);
  // A failing step leaves no open journal run: the next command starts a fresh one.
  const begins = [];
  const realBegin = journal.begin;
  test.mock.method(journal, 'begin', (...args) => {
    const run = realBegin(...args);
    begins.push(run.depth);
    return run;
  });
  execute(['run', file, dir]);
  assert.strictEqual(begins[0], 1, 'the recipe started a fresh journal run');
});

test('a remove step is last and only previews: it shows the list and the confirmation value and never deletes', () => {
  const dir = tempDir();
  make(dir, { 'a.bin': 'AAAA', 'sub/b.bin': 'AAAA', 'x/y/c.txt': 'unique' });
  const file = recipeFile({ steps: ['flatten', 'remove-same-content'] });
  const seen = [];
  const spy = (argv, options) => {
    seen.push(argv);
    return execute(argv, options);
  };
  const result = runRecipe(file, dir, { execute: spy });
  assert.deepStrictEqual(result.steps.map((step) => step.status), ['done', 'preview']);
  assert.ok(seen.every((argv) => !argv.some((arg) => /^--(yes|force|permanent)/.test(arg))), 'no step carries --yes, --force or --permanent');
  const output = formatRecipe(result);
  assert.match(output, /Step 2\/2: remove-same-content \(preview only: nothing deleted\)/);
  assert.match(output, /with --yes=[0-9a-f]{12} to send them to the Recycle Bin/);
  assert.deepStrictEqual(recycled, []);
  assert.deepStrictEqual(fs.readdirSync(dir).filter((name) => /\.bin$/.test(name)).sort(), ['a.bin', 'b.bin'], 'both copies are still there');
});

test('it stops at the first failure and says which steps did not run', () => {
  const dir = tempDir();
  make(dir, { 'sub/a.txt': 'x' });
  // The second step fails: a bad option value is refused when the step runs.
  const file = recipeFile({ steps: ['flatten', { command: 'find-low-quality', options: ['--min-height=abc'] }, 'normalize'] });
  const result = runRecipe(file, dir, { execute });
  assert.deepStrictEqual(result.steps.map((step) => step.status), ['done', 'failed', 'not run']);
  assert.strictEqual(result.failed, true);
  const output = formatRecipe(result);
  assert.match(output, /Step 2\/3: find-low-quality --min-height=abc \(FAILED\)/);
  assert.match(output, /Error: /);
  assert.match(output, /Step 3\/3: normalize \(not run\)/);
  assert.match(output, /Stopped at the first failure: 1 of 3 steps finished\./);
  assert.throws(() => run(['run', file, dir]), /Step 2\/3: find-low-quality/s);
  // A step that reports a failure (not an exception) stops the recipe too.
  const reported = runRecipe(recipeFile({ steps: ['flatten', 'normalize'] }), dir, {
    execute: (argv) => (argv[0] === 'flatten' ? { report: 'half done', failure: Object.assign(new Error('1 file failed'), { output: 'half done report' }) } : { report: '' }),
  });
  assert.deepStrictEqual(reported.steps.map((step) => step.status), ['failed', 'not run']);
  assert.match(formatRecipe(reported), /half done report/);
});

test('progress lines of a step name the step', () => {
  const dir = tempDir();
  make(dir, { 'a.bin': 'AAAA', 'b.bin': 'AAAA' });
  const lines = [];
  runRecipe(recipeFile({ steps: ['find-same-content'] }), dir, { execute, progress: (line) => lines.push(line) });
  assert.deepStrictEqual(lines, ['Step 1/1 find-same-content: Hashing 2 files that share a size with another file...']);
});

test('the target and the arguments of run are checked like the other whole-target commands', () => {
  const dir = tempDir();
  const file = recipeFile({ steps: ['flatten'] });
  assert.throws(() => run(['run']), /Usage: fctl run <recipe\.json> <target>/);
  assert.throws(() => run(['run', file]), /Usage: fctl run/);
  assert.throws(() => run(['run', file, dir, 'extra']), /Only one recipe and one target/);
  assert.throws(() => run(['run', file, dir, '--force']), /never overwrites/);
  assert.throws(() => run(['run', file, dir, '--permanent']), /never overwrites/);
  assert.throws(() => run(['run', file, 'C:folder']), /Write a path after the drive letter/);
  assert.throws(() => run(['run', file, path.parse(os.tmpdir()).root]), /protected path/);
  assert.throws(() => run(['run', file, path.join(dir, 'missing')]), /does not exist/);
  assert.match(run(['--help']), /^ {2}run <recipe\.json> <target>/m);
});

test('each step is journaled as part of one run', () => {
  const dir = tempDir();
  make(dir, { 'sub/a.txt': 'x' });
  const journal = require('../src/journal');
  const begins = [];
  const realBegin = journal.begin;
  test.mock.method(journal, 'begin', (...args) => {
    begins.push(args[0]);
    return realBegin(...args);
  });
  execute(['run', recipeFile({ steps: ['flatten', 'normalize'] }), dir]);
  assert.deepStrictEqual(begins, ['run', 'flatten', 'normalize']);
});

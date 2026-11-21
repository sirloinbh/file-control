'use strict';

// The dry run says by a flag, not by its words, that something would be overwritten or replaced (#361).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execute } = require('../src/execute');
const files = require('../src/ui/screens/files');

const isWindows = process.platform === 'win32';

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-flag-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// [name, argv builder (p = path in the folder), setup of the existing target, setup of what is always there]
const COMMANDS = [
  ['write', (p) => ['write', p('t.txt'), 'x', '--force'], (p) => fs.writeFileSync(p('t.txt'), 'old')],
  ['rename', (p) => ['rename', p('a.txt'), 't.txt', '--force'], (p) => fs.writeFileSync(p('t.txt'), 'old')],
  ['mv file', (p) => ['mv', p('a.txt'), p('d'), '--force'], (p) => fs.writeFileSync(p('d', 'a.txt'), 'old')],
  ['mv folder', (p) => ['mv', p('f'), p('d'), '--force'], (p) => fs.mkdirSync(p('d', 'f'))],
  ['cp file', (p) => ['cp', p('a.txt'), p('d'), '--force'], (p) => fs.writeFileSync(p('d', 'a.txt'), 'old')],
  ['cp folder', (p) => ['cp', p('f'), p('d'), '--force'], (p) => fs.mkdirSync(p('d', 'f'))],
  ['zip', (p) => ['zip', p('t.zip'), p('a.txt'), '--force'], (p) => fs.writeFileSync(p('t.zip'), 'old')],
  ['unzip', (p) => ['unzip', p('x.zip'), p('out'), '--force'], (p) => fs.mkdirSync(p('out'))],
];

for (const [name, argvOf, makeTarget] of COMMANDS) {
  test(`${name}: the dry run sets overwrites only when the target exists (#361)`, { skip: !isWindows && 'needs tar.exe' }, () => {
    for (const exists of [false, true]) {
      const dir = tempDir();
      const p = (...parts) => path.join(dir, ...parts);
      fs.writeFileSync(p('a.txt'), 'new');
      fs.mkdirSync(p('f'));
      fs.writeFileSync(p('f', 'in.txt'), 'in');
      fs.mkdirSync(p('d'));
      if (name === 'unzip') execute(['zip', p('x.zip'), p('a.txt')]);
      if (exists) makeTarget(p);
      const outcome = execute([...argvOf(p), '--dry-run']);
      assert.strictEqual(outcome.overwrites === true, exists, `${name} exists=${exists}: ${JSON.stringify(outcome.result)}`);
    }
  });
}

test('the files preview warns from the flag, not from the words of the lines (#361)', () => {
  const warned = (outcome) => String(files.views.mv(outcome)).includes('Existing items would be overwritten or replaced');
  // The note text is reworded (a scratch run): the flag still makes the warning appear.
  assert.ok(warned({ command: 'mv', result: ['[Preview] Move: a -> b (the old one is gone afterwards)'], overwrites: true }));
  // The old words without the flag give no warning.
  assert.ok(!warned({ command: 'mv', result: ['[Preview] Move: a -> b (overwrites)', 'x (replaces the whole folder)', 'y overwritten'] }));
  assert.ok(!warned({ command: 'mv', result: ['[Preview] Move: a -> b'], overwrites: false }));
});

test('the flag survives toPlain and the earlier-item case of cp sets it (#361)', () => {
  const { toPlain } = require('../src/ui/serialize');
  assert.strictEqual(toPlain({ command: 'mv', result: ['x'], overwrites: true }).overwrites, true);
  const dir = tempDir();
  const p = (...parts) => path.join(dir, ...parts);
  fs.mkdirSync(p('x'));
  fs.mkdirSync(p('y'));
  fs.mkdirSync(p('d'));
  fs.writeFileSync(p('x', 'same.txt'), '1');
  fs.writeFileSync(p('y', 'same.txt'), '2');
  const outcome = execute(['cp', p('x', 'same.txt'), p('y', 'same.txt'), p('d'), '--force', '--dry-run']);
  assert.strictEqual(outcome.overwrites, true);
  assert.match(outcome.result[1], /overwrites: earlier item/);
});

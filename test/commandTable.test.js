'use strict';

// The command table drives the help text and the option checks (#362).

const test = require('node:test');
const assert = require('node:assert');
const { run } = require('../bin/fctl');
const { execute } = require('../src/execute');
const { COMMANDS, helpCommandLines, misplacedFlagMessage } = require('../src/commandTable');

test('the help text lists every command of the table, in order, and nothing else', () => {
  const help = run(['--help']);
  const listed = help.split('\n').slice(4).filter((line) => /^ {2}[a-z]/.test(line)).slice(0, COMMANDS.length);
  assert.deepStrictEqual(listed, helpCommandLines());
  assert.strictEqual(listed.length, COMMANDS.length);
  for (const command of COMMANDS) assert.ok(help.includes(`  ${command.usage}`), command.name);
  // A command added to the table shows in the help without a second edit.
  COMMANDS.push({ name: 'fctltest', usage: 'fctltest <x>', summary: 'scratch', kind: 'basic' });
  try {
    assert.ok(run(['--help']).includes('  fctltest <x>'));
  } finally {
    COMMANDS.pop();
  }
});

test('every command of the table is known to execute (none is refused as an unknown command)', () => {
  for (const { name, kind } of COMMANDS) {
    if (kind === 'ui') continue;
    // clean-downloads has an optional folder, so it would look at the real Downloads folder; test/cleanDownloads.test.js checks it with a temporary one.
    if (name === 'clean-downloads') continue;
    try {
      execute([name, '--dry-run'], { readStdin: () => '' });
    } catch (err) {
      assert.ok(!err.unknownCommand, `${name} is in the table but unknown to execute`);
    }
  }
  assert.throws(() => execute(['fctl-no-such-command']), (err) => err.unknownCommand === true);
});

test('the option checks read the table', () => {
  const flags = (...names) => new Set(names);
  // --force: only the commands marked force; --permanent: only rm and mv (mv needs --force too).
  for (const { name, kind, force } of COMMANDS) {
    if (kind !== 'basic') continue;
    assert.strictEqual(misplacedFlagMessage(name, flags('force')) === undefined, Boolean(force), `--force on ${name}`);
  }
  assert.strictEqual(misplacedFlagMessage('rm', flags('permanent')), undefined);
  assert.strictEqual(misplacedFlagMessage('mv', flags('permanent', 'force')), undefined);
  assert.match(misplacedFlagMessage('mv', flags('permanent')), /only applies with --force/);
  assert.match(misplacedFlagMessage('cp', flags('permanent')), /does not use --permanent/);
  // The whole-target commands are not looked at for --force and --permanent here (checkWholeTarget refuses them).
  assert.strictEqual(misplacedFlagMessage('flatten', flags('force')), undefined);
  // The other options by the field of the command.
  for (const { name, removeArchives, yes, includeLowercase, lowQuality } of COMMANDS) {
    assert.strictEqual(misplacedFlagMessage(name, flags('remove-archives')) === undefined, Boolean(removeArchives), `--remove-archives on ${name}`);
    assert.strictEqual(misplacedFlagMessage(name, flags('yes')) === undefined, Boolean(yes), `--yes on ${name}`);
    assert.strictEqual(misplacedFlagMessage(name, flags('include-lowercase')) === undefined, Boolean(includeLowercase), `--include-lowercase on ${name}`);
    assert.strictEqual(misplacedFlagMessage(name, flags('min-height')) === undefined, Boolean(lowQuality), `--min-height on ${name}`);
    assert.strictEqual(misplacedFlagMessage(name, flags('min-bitrate')) === undefined, Boolean(lowQuality), `--min-bitrate on ${name}`);
  }
});

test('the option checks keep their order when two options are wrong at once', () => {
  const flags = (...names) => new Set(names);
  // --remove-archives is checked before --yes, --yes before --force, --force before --include-lowercase.
  assert.match(misplacedFlagMessage('ls', flags('yes', 'remove-archives')), /--remove-archives/);
  assert.match(misplacedFlagMessage('ls', flags('force', 'yes')), /--yes/);
  assert.match(misplacedFlagMessage('ls', flags('include-lowercase', 'force')), /does not use --force/);
  assert.match(misplacedFlagMessage('mv', flags('permanent', 'include-lowercase')), /mv --permanent only applies with --force/);
});

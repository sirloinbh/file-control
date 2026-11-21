'use strict';

// The basic file screens (#256): form -> preview -> run -> result for mkdir, write, append, rename, mv, cp and rm,
// and the read-only ls and cat pages. It uses the real server, the real job process and real files in a temp folder.
// The temp folder is under the real user folder (AppData), which is a protected place, so os.homedir is swapped with a fake path
// (the same approach as test/uiCheckedRun.test.js), and the job process gets the same fake home.
// rm runs only with --permanent (plain fs.rmSync) so no test reaches the real Recycle Bin; the Recycle Bin form is checked only up to its preview.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FAKE_HOME = path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home');
let currentHome = FAKE_HOME;
test.mock.method(os, 'homedir', () => currentHome);

const { FcError } = require('../src/commands');
const { startUi } = require('./uiClient');
const { createJobs } = require('../src/ui/jobs');
const { jobRoutes } = require('../src/ui/jobPages');
const { flowRoutes } = require('../src/ui/flowPages');
const files = require('../src/ui/screens/files');

const spec = (command) => files.specs.find((candidate) => candidate.command === command);
const argvOf = (command, values) => spec(command).toArgv(values);

function tempDir() {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fc-files-screens-')));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function settled(jobs, job, timeoutMs = 30000) {
  const until = Date.now() + timeoutMs;
  while (job.status === 'running' || jobs.running() === job) {
    if (Date.now() > until) throw new Error(`The job did not finish: ${job.argv.join(' ')}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function serve(t) {
  // The job process gets the fake Recycle Bin, because mv --force sends the replaced item to the Recycle Bin (#311).
  const PRELOAD = path.join(__dirname, 'fakeRecyclePreload.js');
  const fork = (workerPath, args, options) => require('node:child_process').fork(workerPath, args, { ...options, execArgv: [...process.execArgv, '--require', PRELOAD] });
  const jobs = createJobs({ env: { ...process.env, USERPROFILE: FAKE_HOME }, fork });
  const routes = new Map([
    ...jobRoutes(jobs, { specs: files.specs, views: files.views }),
    ...flowRoutes(jobs, files.specs),
    ...files.routes(jobs),
  ]);
  const { server, url, get, post } = await startUi({ routes });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  // Follows the 303 to the job, waits for it to end and returns the result page.
  const finish = async (res) => {
    assert.strictEqual(res.status, 303, await res.clone().text());
    const id = new URL(res.headers.get('location'), url).searchParams.get('id');
    const job = jobs.get(id);
    await settled(jobs, job);
    const result = await get(`/job/result?id=${id}`);
    assert.strictEqual(result.status, 200);
    return { job, body: await result.text() };
  };
  // Preview, then run with the fingerprint the preview page carries (and the confirmations the page asks for).
  const previewAndRun = async (command, fields, confirm = {}) => {
    const base = `/files/${command}`;
    const preview = await finish(await post(`${base}/preview`, fields));
    const fingerprint = /name="fingerprint" value="([0-9a-f]{64})"/.exec(preview.body)?.[1];
    assert.ok(fingerprint, `the preview carries a Run form: ${preview.body}`);
    const run = await finish(await post(`${base}/run`, { ...fields, fingerprint, ...confirm }));
    return { preview, run };
  };
  return { jobs, get, post, finish, previewAndRun };
}

// &amp; is decoded last so that an escaped entity such as &amp;lt; does not turn into <.
const decode = (body) => body.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

// ---------- Checking the input (no server) ----------

test('toArgv refuses relative paths, option-like paths and protected places, and never lets a value become an option', () => {
  const dir = tempDir();
  assert.throws(() => argvOf('mkdir', { folder: 'relative\\dir' }), /full path/);
  assert.throws(() => argvOf('mkdir', { folder: '' }), FcError);
  assert.throws(() => argvOf('mkdir', { folder: '--force' }), /dash/);
  assert.throws(() => argvOf('mkdir', { folder: 'C:\\Windows\\System32\\x' }), /protected/);
  assert.throws(() => argvOf('mkdir', { folder: '\\\\server\\share\\x' }), /Network/);
  assert.throws(() => argvOf('mkdir', { folder: `${dir}\nC:\\x` }), /line break/);
  assert.deepStrictEqual(argvOf('mkdir', { folder: ` ${dir}\\new ` }), ['mkdir', `${dir}\\new`]);

  // The content is after -- (so it is never an option) and line breaks are made plain \n.
  assert.deepStrictEqual(argvOf('write', { file: `${dir}\\a.txt`, content: '--force\r\n- item\r\n', force: '' }), ['write', `${dir}\\a.txt`, '--', '--force\n- item\n']);
  assert.deepStrictEqual(argvOf('write', { file: `${dir}\\a.txt`, content: '', force: 'on' }), ['write', `${dir}\\a.txt`, '--force', '--', '']);
  assert.deepStrictEqual(argvOf('append', { file: `${dir}\\a.txt`, content: 'x' }), ['append', `${dir}\\a.txt`, '--', 'x']);
  assert.throws(() => argvOf('write', { file: `${dir}\\a.txt`, content: 'x'.repeat(30000) }), /too long/);

  assert.throws(() => argvOf('rename', { target: `${dir}\\a.txt`, name: 'sub\\b.txt' }), /cannot contain a path/);
  assert.throws(() => argvOf('rename', { target: `${dir}\\a.txt`, name: '' }), /new name/);
  assert.deepStrictEqual(argvOf('rename', { target: `${dir}\\a.txt`, name: 'b.txt', force: 'on' }), ['rename', `${dir}\\a.txt`, 'b.txt', '--force']);

  assert.deepStrictEqual(
    argvOf('mv', { sources: `${dir}\\a.txt\r\n\r\n  ${dir}\\b.txt  \r\n`, dest: `${dir}\\to`, force: '' }),
    ['mv', `${dir}\\a.txt`, `${dir}\\b.txt`, `${dir}\\to`],
  );
  assert.deepStrictEqual(argvOf('cp', { sources: `${dir}\\a.txt`, dest: `${dir}\\to`, force: 'on' }), ['cp', '--force', `${dir}\\a.txt`, `${dir}\\to`]);
  assert.throws(() => argvOf('mv', { sources: '\n\n', dest: `${dir}\\to` }), /one per line/);
  assert.throws(() => argvOf('mv', { sources: Array(files.MAX_SOURCES + 1).fill(`${dir}\\a`).join('\n'), dest: dir }), /Too many/);
  assert.deepStrictEqual(argvOf('rm', { targets: `${dir}\\a.txt\n${dir}\\b.txt`, permanent: '' }), ['rm', `${dir}\\a.txt`, `${dir}\\b.txt`]);
  assert.deepStrictEqual(argvOf('rm', { targets: `${dir}\\a.txt`, permanent: 'on' }), ['rm', '--permanent', `${dir}\\a.txt`]);
});

// ---------- Landing page and forms ----------

test('the landing page lists every command, and each form shows a Preview button, a textarea where needed, and unchecked dangerous options', async (t) => {
  const { get } = await serve(t);
  const landing = await (await get('/files')).text();
  for (const command of ['ls', 'cat', 'mkdir', 'write', 'append', 'rename', 'mv', 'cp', 'rm']) assert.match(landing, new RegExp(`href="/files/${command}"`));

  for (const spec of files.specs) {
    const body = await (await get(spec.path)).text();
    assert.match(body, new RegExp(`<form method="post" action="${spec.path}/preview">`));
    assert.match(body, /<button type="submit">Preview<\/button>/);
    assert.doesNotMatch(body, /checked/, 'overwrite and permanent delete start off');
  }
  assert.match(await (await get('/files/write')).text(), /<textarea name="content"/);
  assert.match(await (await get('/files/mv')).text(), /<textarea name="sources"/);
  // Even if the address asks for it, a dangerous option stays off.
  assert.doesNotMatch(await (await get('/files/rm?permanent=on')).text(), /checked/);
});

// ---------- ls ----------

test('ls shows name, type, size and modified time, and links folders to ls and files to cat', async (t) => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'a & b.txt'), 'x'.repeat(2048));
  const { get } = await serve(t);
  const res = await get(`/files/ls?${new URLSearchParams({ dir })}`);
  assert.strictEqual(res.status, 200);
  const body = await res.text();
  assert.match(body, /<th scope="col">Name<\/th>/);
  assert.match(body, /<th scope="col">Modified<\/th>/);
  assert.match(body, />sub<\/a><\/td><td>Folder<\/td>/);
  assert.match(body, /a &amp; b\.txt<\/a><\/td><td>File<\/td><td>2\.0KB<\/td><td>\d{4}-\d\d-\d\d \d\d:\d\d<\/td>/);
  assert.doesNotMatch(body, /a & b/, 'file names are escaped');
  assert.match(body, /href="\/files\/cat\?file=[^"]*a\+%26\+b\.txt"/);
  assert.match(body, /href="\/files\/ls\?dir=[^"]*sub"/);
});

test('ls labels a junction as a link to a folder with an ls link, and a broken link without a link (#331)', async (t) => {
  const dir = tempDir();
  const real = path.join(dir, 'real');
  fs.mkdirSync(real);
  fs.symlinkSync(real, path.join(dir, 'junc'), 'junction');
  const gone = path.join(dir, 'gone');
  fs.mkdirSync(gone);
  fs.symlinkSync(gone, path.join(dir, 'broken'), 'junction');
  fs.rmdirSync(gone);
  const { get } = await serve(t);
  const body = await (await get(`/files/ls?${new URLSearchParams({ dir })}`)).text();
  assert.match(body, /href="\/files\/ls\?dir=[^"]*junc">junc<\/a> <span class="muted">-> [^<]*real[^<]*<\/span><\/td><td>Link to a folder<\/td>/);
  assert.match(body, /href="\/files\/ls\?dir=[^"]*junc"/);
  assert.doesNotMatch(body, /files\/cat\?file=[^"]*junc"/);
  assert.match(body, /broken <span class="muted">[^<]*<\/span><\/td><td>Broken link<\/td>/);
  assert.doesNotMatch(body, /href="[^"]*broken"/);
});

test('ls refuses a relative path, a file and a missing folder with a message, and an address opened from another site', async (t) => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  const { get } = await serve(t);
  const ask = async (dirValue, init) => (await get(`/files/ls?${new URLSearchParams({ dir: dirValue })}`, init)).text();
  assert.match(await ask('relative'), /must be a full path/);
  assert.match(await ask(path.join(dir, 'a.txt')), /Not a folder/);
  assert.match(await ask(path.join(dir, 'missing')), /Could not read the folder|does not exist|Not found/i);
  const cross = await ask(dir, { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.match(cross, /another site/);
  assert.doesNotMatch(cross, /a\.txt/);
});

// ---------- cat ----------

test('cat shows a text file as it is, the start of a large file with a notice, and a binary file as hex with a notice', async (t) => {
  const dir = tempDir();
  const text = path.join(dir, 'note.txt');
  fs.writeFileSync(text, 'line 1\n  indented <tag> & more\n\nlast');
  const large = path.join(dir, 'large.log');
  fs.writeFileSync(large, `${'A'.repeat(files.CAT_BYTES)}TAIL-MARKER`);
  const binary = path.join(dir, 'blob.bin');
  fs.writeFileSync(binary, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0xff, 0xfe, ...Buffer.from('hidden-text')]));
  const { get } = await serve(t);
  const cat = async (file, init) => (await get(`/files/cat?${new URLSearchParams({ file })}`, init)).text();

  const plain = await cat(text);
  assert.match(plain, /<pre class="report">line 1\n  indented &lt;tag&gt; &amp; more\n\nlast<\/pre>/);
  assert.doesNotMatch(plain, /only the first/);

  const big = await cat(large);
  assert.match(big, /This file is large .* only the first 64\.0KB are shown/);
  assert.doesNotMatch(big, /TAIL-MARKER/);

  const bin = await cat(binary);
  assert.match(bin, /looks like a binary file/);
  assert.match(bin, /50 4b 03 04 00 00 ff fe/);

  assert.match(await cat(dir), /Not a regular file/);
  assert.match(await cat('relative.txt'), /must be a full path/);
  const cross = await cat(text, { headers: { 'sec-fetch-site': 'same-site' } });
  assert.match(cross, /another site/);
  assert.doesNotMatch(cross, /indented/);
});

test('cat does not show a file inside a protected place', async (t) => {
  const { get } = await serve(t);
  const res = await get(`/files/cat?${new URLSearchParams({ file: 'C:\\Windows\\win.ini' })}`);
  assert.match(await res.text(), /protected place/);
});

// ---------- Changing commands: form submit -> preview -> run -> result ----------

test('mkdir: a preview creates nothing, the run creates the folder and the result says so', async (t) => {
  const dir = tempDir();
  const folder = path.join(dir, 'new', 'nested');
  const { finish, post, previewAndRun } = await serve(t);
  const preview = await finish(await post('/files/mkdir/preview', { folder }));
  assert.match(decode(preview.body), /What will happen/);
  assert.match(decode(preview.body), new RegExp(`Create folder: ${folder.replace(/\\/g, '\\\\')}`));
  assert.ok(!fs.existsSync(folder));

  const { run } = await previewAndRun('mkdir', { folder });
  assert.strictEqual(run.job.outcome.ran, true, run.body);
  assert.ok(fs.statSync(folder).isDirectory());
  assert.match(run.body, /Created/);
});

test('write: the content (with --force, a dash line and a blank line) is written as typed; an existing file needs overwrite and its confirmation', async (t) => {
  const dir = tempDir();
  const file = path.join(dir, 'out.txt');
  const content = '--force\r\n- item\r\n\r\n<b>tail</b>';
  const { jobs, finish, post, previewAndRun } = await serve(t);

  const { preview, run } = await previewAndRun('write', { file, content });
  assert.match(preview.body, /Write file/);
  assert.strictEqual(run.job.outcome.ran, true, run.body);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '--force\n- item\n\n<b>tail</b>');

  // The file exists now: without overwrite the preview itself fails and nothing changes.
  const refused = await finish(await post('/files/write/preview', { file, content: 'new' }));
  assert.strictEqual(refused.job.status, 'error');
  assert.match(refused.body, /Already exists/);

  // With overwrite on, the preview warns and asks for one more confirmation.
  const fields = { file, content: 'new', force: 'on' };
  const overwritePreview = await finish(await post('/files/write/preview', fields));
  assert.match(overwritePreview.body, /\(overwrites\)/);
  assert.match(overwritePreview.body, /name="confirm-force" value="yes" required/);
  const fingerprint = /name="fingerprint" value="([0-9a-f]{64})"/.exec(overwritePreview.body)[1];
  const unconfirmed = await post('/files/write/run', { ...fields, fingerprint });
  assert.strictEqual(unconfirmed.status, 400);
  assert.match(await unconfirmed.text(), /not confirmed again/);
  assert.strictEqual(jobs.running(), null);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '--force\n- item\n\n<b>tail</b>', 'nothing is overwritten without the confirmation');

  const confirmed = await finish(await post('/files/write/run', { ...fields, fingerprint, 'confirm-force': 'yes' }));
  assert.strictEqual(confirmed.job.outcome.ran, true, confirmed.body);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'new');
});

test('write: the Run form of the preview carries the typed content, so a multi-line text previews and runs to the same result', async (t) => {
  const dir = tempDir();
  const file = path.join(dir, 'multi.txt');
  const { finish, post } = await serve(t);
  const preview = await finish(await post('/files/write/preview', { file, content: 'a\nb\n' }));
  assert.match(preview.body, /<input type="hidden" name="content" value="a\nb\n">/);
});

test('append: the preview changes nothing, the run adds to the end, and a new file is created', async (t) => {
  const dir = tempDir();
  const file = path.join(dir, 'log.txt');
  fs.writeFileSync(file, 'one\n');
  const { previewAndRun } = await serve(t);
  const { preview, run } = await previewAndRun('append', { file, content: 'two\r\nthree' });
  assert.match(preview.body, /Append to file/);
  assert.strictEqual(run.job.outcome.ran, true, run.body);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'one\ntwo\nthree');
  assert.match(run.body, /Appended/);

  const fresh = path.join(dir, 'fresh.txt');
  await previewAndRun('append', { file: fresh, content: 'x' });
  assert.strictEqual(fs.readFileSync(fresh, 'utf8'), 'x');
});

test('rename: renames within the folder; an existing new name is refused unless overwrite is confirmed', async (t) => {
  const dir = tempDir();
  const a = path.join(dir, 'a.txt');
  const b = path.join(dir, 'b.txt');
  fs.writeFileSync(a, 'A');
  fs.writeFileSync(b, 'B');
  const { finish, post, previewAndRun } = await serve(t);

  const refused = await finish(await post('/files/rename/preview', { target: a, name: 'b.txt' }));
  assert.strictEqual(refused.job.status, 'error');
  assert.match(refused.body, /Already exists/);
  assert.strictEqual(fs.readFileSync(b, 'utf8'), 'B');

  const { run } = await previewAndRun('rename', { target: a, name: 'c.txt' });
  assert.strictEqual(run.job.outcome.ran, true, run.body);
  assert.ok(!fs.existsSync(a));
  assert.strictEqual(fs.readFileSync(path.join(dir, 'c.txt'), 'utf8'), 'A');
  assert.match(run.body, /Renamed/);

  const bad = await post('/files/rename/preview', { target: b, name: '..\\x.txt' });
  assert.strictEqual(bad.status, 400);
  assert.match(await bad.text(), /cannot contain a path/);

  const overwrite = await previewAndRun('rename', { target: path.join(dir, 'c.txt'), name: 'b.txt', force: 'on' }, { 'confirm-force': 'yes' });
  assert.strictEqual(overwrite.run.job.outcome.ran, true, overwrite.run.body);
  assert.strictEqual(fs.readFileSync(b, 'utf8'), 'A');
});

test('mv: several sources (one per line) are moved into the destination folder; overwrite needs its confirmation', async (t) => {
  const dir = tempDir();
  const dest = path.join(dir, 'to');
  fs.mkdirSync(dest);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'A');
  fs.mkdirSync(path.join(dir, 'folder'));
  fs.writeFileSync(path.join(dir, 'folder', 'inner.txt'), 'I');
  const sources = `${path.join(dir, 'a.txt')}\r\n${path.join(dir, 'folder')}\r\n`;
  const { jobs, post, previewAndRun } = await serve(t);

  const { preview, run } = await previewAndRun('mv', { sources, dest });
  assert.strictEqual(decode(preview.body).match(/Move: /g).length, 2, 'both items are in the preview');
  assert.strictEqual(run.job.outcome.ran, true, run.body);
  assert.deepStrictEqual(fs.readdirSync(dest).sort(), ['a.txt', 'folder']);
  assert.ok(!fs.existsSync(path.join(dir, 'a.txt')));
  assert.match(run.body, /Moved/);

  // A file with the same name in the destination: without overwrite the preview fails, with it the run needs the confirmation.
  fs.writeFileSync(path.join(dir, 'a.txt'), 'NEW');
  const fields = { sources: path.join(dir, 'a.txt'), dest, force: 'on' };
  const unconfirmed = await post('/files/mv/run', { ...fields, fingerprint: 'd'.repeat(64) });
  assert.strictEqual(unconfirmed.status, 400);
  assert.strictEqual(jobs.running(), null);
  assert.strictEqual(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8'), 'A');
  const confirmed = await previewAndRun('mv', fields, { 'confirm-force': 'yes' });
  assert.strictEqual(confirmed.run.job.outcome.ran, true, confirmed.run.body);
  assert.strictEqual(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8'), 'NEW');
});

test('cp: several sources are copied and the originals stay; a missing source is reported and nothing is copied', async (t) => {
  const dir = tempDir();
  const dest = path.join(dir, 'to');
  fs.mkdirSync(dest);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'A');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'B');
  const { finish, post, previewAndRun } = await serve(t);

  const sources = `${path.join(dir, 'a.txt')}\n${path.join(dir, 'b.txt')}`;
  const { run } = await previewAndRun('cp', { sources, dest });
  assert.strictEqual(run.job.outcome.ran, true, run.body);
  assert.deepStrictEqual(fs.readdirSync(dest).sort(), ['a.txt', 'b.txt']);
  assert.ok(fs.existsSync(path.join(dir, 'a.txt')), 'the originals stay');
  assert.match(run.body, /Copied/);

  const missing = await finish(await post('/files/cp/preview', { sources: `${path.join(dir, 'a.txt')}\n${path.join(dir, 'nope.txt')}`, dest: path.join(dir, 'to2') }));
  assert.strictEqual(missing.job.status, 'error');
  assert.match(missing.body, /nope\.txt/);
  assert.ok(!fs.existsSync(path.join(dir, 'to2')));
});

test('rm: permanent delete of several items needs the extra confirmation, and only a confirmed run deletes', async (t) => {
  const dir = tempDir();
  const a = path.join(dir, 'a.txt');
  const folder = path.join(dir, 'folder');
  fs.writeFileSync(a, 'A');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'x.txt'), 'X');
  const fields = { targets: `${a}\n${folder}`, permanent: 'on' };
  const { jobs, finish, post } = await serve(t);

  const preview = await finish(await post('/files/rm/preview', fields));
  assert.match(preview.body, /Delete permanently/);
  assert.match(preview.body, /name="confirm-permanent" value="yes" required/);
  assert.ok(fs.existsSync(a) && fs.existsSync(folder), 'a preview deletes nothing');
  const fingerprint = /name="fingerprint" value="([0-9a-f]{64})"/.exec(preview.body)[1];

  for (const confirm of [{}, { 'confirm-permanent': 'no' }]) {
    const res = await post('/files/rm/run', { ...fields, fingerprint, ...confirm });
    assert.strictEqual(res.status, 400);
    assert.match(await res.text(), /not confirmed again/);
    assert.strictEqual(jobs.running(), null);
    assert.ok(fs.existsSync(a) && fs.existsSync(folder));
  }

  const run = await finish(await post('/files/rm/run', { ...fields, fingerprint, 'confirm-permanent': 'yes' }));
  assert.strictEqual(run.job.outcome.ran, true, run.body);
  assert.ok(!fs.existsSync(a) && !fs.existsSync(folder));
  assert.match(run.body, /Deleted/);
});

test('rm: the default form is the Recycle Bin and has no permanent confirmation (preview only, nothing is deleted)', { skip: process.platform !== 'win32' }, async (t) => {
  const dir = tempDir();
  const a = path.join(dir, 'a.txt');
  fs.writeFileSync(a, 'A');
  const { finish, post } = await serve(t);
  const preview = await finish(await post('/files/rm/preview', { targets: a }));
  assert.strictEqual(preview.job.status, 'done', preview.body);
  assert.match(preview.body, /Move to the Recycle Bin/);
  assert.doesNotMatch(preview.body, /confirm-permanent/);
  assert.ok(fs.existsSync(a));
});

test('a changing request with a bad path shows the reason (400) and starts no job', async (t) => {
  const { jobs, post } = await serve(t);
  for (const [command, fields, message] of [
    ['mkdir', { folder: 'relative' }, /full path/],
    ['mv', { sources: '', dest: 'C:\\x' }, /one per line/],
    ['rm', { targets: 'C:\\Windows\\System32' }, /protected/],
    ['write', { file: '', content: 'x' }, /Enter the file/i],
  ]) {
    const res = await post(`/files/${command}/preview`, fields);
    assert.strictEqual(res.status, 400, command);
    assert.match(await res.text(), message);
    assert.strictEqual(jobs.running(), null);
  }
});

// ---------- Links, short names and hidden settings folders ----------

// A real home folder with .ssh and AppData inside, so a link to them can be made. The server (this process) sees it as the user folder.
function makeHome(t) {
  const base = tempDir();
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
  fs.mkdirSync(path.join(home, 'AppData', 'Roaming'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ssh', 'secret.txt'), 'PRIVATE-KEY');
  currentHome = home;
  t.after(() => { currentHome = FAKE_HOME; });
  return { base, home };
}

test('a path inside a hidden settings folder is refused by every changing command', (t) => {
  const { home } = makeHome(t);
  const inside = path.join(home, '.ssh', 'x');
  assert.throws(() => argvOf('mkdir', { folder: inside }), /protected/);
  assert.throws(() => argvOf('write', { file: inside, content: 'x' }), /protected/);
  assert.throws(() => argvOf('append', { file: inside, content: 'x' }), /protected/);
  assert.throws(() => argvOf('rename', { target: inside, name: 'y' }), /protected/);
  assert.throws(() => argvOf('rm', { targets: path.join(home, 'AppData', 'Roaming') }), /protected/);
  assert.throws(() => argvOf('mv', { sources: inside, dest: home }), /protected/);
  assert.doesNotThrow(() => argvOf('mkdir', { folder: path.join(home, 'Downloads', 'x') }));
});

test('a junction into a protected place is refused for cat, rm, mv (source and destination), cp, mkdir, write and rename', async (t) => {
  const { base, home } = makeHome(t);
  const link = path.join(base, 'link');
  fs.symlinkSync(path.join(home, '.ssh'), link, 'junction');
  const ok = path.join(base, 'plain.txt');
  fs.writeFileSync(ok, 'plain');
  const through = path.join(link, 'secret.txt');

  assert.throws(() => argvOf('rm', { targets: through }), /protected/);
  assert.throws(() => argvOf('rm', { targets: link }), /protected/);
  assert.throws(() => argvOf('mv', { sources: through, dest: base }), /protected/);
  assert.throws(() => argvOf('mv', { sources: ok, dest: link }), /protected/);
  assert.throws(() => argvOf('cp', { sources: through, dest: base }), /protected/);
  assert.throws(() => argvOf('cp', { sources: ok, dest: link }), /protected/);
  assert.throws(() => argvOf('mkdir', { folder: path.join(link, 'new', 'deeper') }), /protected/);
  assert.throws(() => argvOf('write', { file: path.join(link, 'new.txt'), content: 'x' }), /protected/);
  assert.throws(() => argvOf('rename', { target: through, name: 'y' }), /protected/);

  const { get } = await serve(t);
  const body = await (await get(`/files/cat?${new URLSearchParams({ file: through })}`)).text();
  assert.match(body, /protected place/);
  assert.doesNotMatch(body, /PRIVATE-KEY/);
  // ls only looks (like the folder picker), so it is not refused.
  assert.match(await (await get(`/files/ls?${new URLSearchParams({ dir: link })}`)).text(), /secret\.txt/);
});

test('a dangling link into a protected place is refused for write, mkdir and mv (#290)', (t) => {
  const { base, home } = makeHome(t);
  const ok = path.join(base, 'ok');
  fs.mkdirSync(ok);
  // A junction to a folder that does not exist yet needs no privilege.
  const dangDir = path.join(ok, 'dangdir');
  fs.symlinkSync(path.join(home, '.ssh', 'newdir'), dangDir, 'junction');
  assert.throws(() => argvOf('mkdir', { folder: dangDir }), /protected/);
  assert.throws(() => argvOf('write', { file: path.join(dangDir, 'x.txt'), content: 'x' }), /protected/);
  assert.throws(() => argvOf('mv', { sources: path.join(base, 'plain.txt'), dest: dangDir }), /protected/);
  // A file symbolic link needs the symlink privilege (or Developer Mode).
  const dang = path.join(ok, 'dang');
  try {
    fs.symlinkSync(path.join(home, '.ssh', 'newfile'), dang, 'file');
  } catch (err) {
    if (err.code !== 'EPERM') throw err;
    t.skip('creating a file symbolic link needs the symlink privilege');
    return;
  }
  assert.throws(() => argvOf('write', { file: dang, content: 'x' }), /protected/);
  assert.ok(!fs.existsSync(path.join(home, '.ssh', 'newfile')));
});

test('an 8.3 short name of a protected folder is refused', { skip: !fs.existsSync('C:\\PROGRA~1') }, () => {
  assert.throws(() => argvOf('mkdir', { folder: 'C:\\PROGRA~1\\x' }), /protected/);
  assert.throws(() => argvOf('rm', { targets: 'C:\\PROGRA~1' }), /protected/);
});

test('accepted paths are normalized with path.resolve (D:/x becomes D:\\x)', () => {
  const dir = tempDir();
  const slashed = dir.replaceAll('\\', '/');
  assert.deepStrictEqual(argvOf('mkdir', { folder: `${slashed}/a/../new` }), ['mkdir', path.join(dir, 'new')]);
  assert.deepStrictEqual(argvOf('rm', { targets: `${slashed}/x.txt` }), ['rm', path.join(dir, 'x.txt')]);
});

test('cp and rename with overwrite on are refused without confirm-force and change nothing', async (t) => {
  const dir = tempDir();
  const dest = path.join(dir, 'to');
  fs.mkdirSync(dest);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'NEW');
  fs.writeFileSync(path.join(dest, 'a.txt'), 'OLD');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'B');
  const { jobs, post } = await serve(t);
  const cases = [
    ['cp', { sources: path.join(dir, 'a.txt'), dest, force: 'on' }],
    ['rename', { target: path.join(dir, 'b.txt'), name: 'a.txt', force: 'on' }],
  ];
  for (const [command, fields] of cases) {
    for (const confirm of [{}, { 'confirm-force': 'no' }]) {
      const res = await post(`/files/${command}/run`, { ...fields, fingerprint: 'e'.repeat(64), ...confirm });
      assert.strictEqual(res.status, 400, command);
      assert.match(await res.text(), /not confirmed again/);
      assert.strictEqual(jobs.running(), null);
    }
  }
  assert.strictEqual(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8'), 'OLD');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'NEW');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8'), 'B');
});

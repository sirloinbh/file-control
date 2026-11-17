'use strict';

// The folder cleanup screens (#257): form -> preview -> run -> result for flatten, collapse, normalize and product-number,
// through the real server and the real job process. normalize, collapse and product-number only rename, so they run for real in temp folders.
// flatten sends emptied folders to the Recycle Bin, so it is only taken up to the preview and the stale-run step here (never a real run).
// Each real run is compared against execute() run directly on a copy of the same folder: the screen must make the same file changes as the CLI.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startUi } = require('./uiClient');
const { createJobs } = require('../src/ui/jobs');
const { jobRoutes } = require('../src/ui/jobPages');
const { flowRoutes } = require('../src/ui/flowPages');
const organize = require('../src/ui/screens/organize');
const { execute } = require('../src/execute');

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'fc-ui-organize-screen-')));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
// The temp folder is inside the user folder (AppData), which whole-folder commands refuse. The job process gets a home folder that does not exist,
// and this process (which runs execute() directly) gets the same through a mock.
const FAKE_HOME = path.join(path.parse(os.tmpdir()).root, 'fc-no-such-home');
test.mock.method(os, 'homedir', () => FAKE_HOME);

let counter = 0;
function makeTree(files) {
  const dir = path.join(root, `case-${counter++}`);
  for (const file of files) {
    fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), file);
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Every file and folder under dir, relative, sorted.
function tree(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      out.push(path.relative(dir, full) + (entry.isDirectory() ? path.sep : ''));
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return out.sort();
}

async function settled(jobs, job, timeoutMs = 120000) {
  const until = Date.now() + timeoutMs;
  while (job.status === 'running' || jobs.running() === job) {
    if (Date.now() > until) throw new Error(`The job did not finish: ${job.argv.join(' ')}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function serve(t) {
  const jobs = createJobs({ env: { ...process.env, USERPROFILE: FAKE_HOME } });
  const routes = new Map([
    ...jobRoutes(jobs, { specs: organize.specs, views: organize.views }),
    ...flowRoutes(jobs, organize.specs),
    ...organize.routes(jobs),
  ]);
  const { server, url, get, post } = await startUi({ routes });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const finish = async (res) => {
    assert.strictEqual(res.status, 303, await res.clone().text());
    const id = new URL(res.headers.get('location'), url).searchParams.get('id');
    const job = jobs.get(id);
    await settled(jobs, job);
    const result = await get(`/job/result?id=${id}`);
    assert.strictEqual(result.status, 200);
    return { job, body: await result.text() };
  };
  return { jobs, get, post, finish };
}

const fingerprintOf = (body) => /name="fingerprint" value="([0-9a-f]{64})"/.exec(body)?.[1];

// Preview, check that nothing changed, run with the preview's fingerprint, and compare with the CLI's execute() on a copy.
async function previewAndRun(t, { command, files, fields = {}, argv }) {
  const dir = makeTree(files);
  const copy = path.join(root, `copy-${counter++}`);
  fs.cpSync(dir, copy, { recursive: true });
  const before = tree(dir);
  const { post, finish } = await serve(t);

  const preview = await finish(await post(`/organize/${command}/preview`, { target: dir, ...fields }));
  assert.strictEqual(preview.job.mode, 'preview', preview.body);
  assert.match(preview.body, /Preview/);
  assert.match(preview.body, /Nothing has been changed yet/);
  assert.deepStrictEqual(tree(dir), before, 'a preview changes nothing');
  const fingerprint = fingerprintOf(preview.body);
  assert.ok(fingerprint, 'the preview carries a Run form with the fingerprint');
  assert.match(preview.body, new RegExp(`action="/organize/${command}/run"`));

  const run = await finish(await post(`/organize/${command}/run`, { target: dir, ...fields, fingerprint }));
  assert.strictEqual(run.job.mode, 'run');
  assert.strictEqual(run.job.outcome.ran, true, run.body);
  assert.doesNotMatch(run.body, /Nothing has been changed yet/);

  execute([...argv, copy]);
  const direct = tree(copy);
  assert.deepStrictEqual(tree(dir), direct, 'the screen makes the same file changes as the CLI');
  assert.notDeepStrictEqual(direct, before, 'the run changed something');
  return { dir, preview, run };
}

test('the category page lists the four commands and every spec lives under /organize (#257)', async (t) => {
  const { get } = await serve(t);
  const res = await get('/organize');
  assert.strictEqual(res.status, 200);
  const body = await res.text();
  for (const spec of organize.specs) {
    assert.ok(spec.path.startsWith('/organize/'));
    assert.ok(body.includes(`href="${spec.path}"`), spec.path);
  }
  assert.deepStrictEqual(organize.specs.map((spec) => spec.command), ['flatten', 'collapse', 'normalize', 'product-number']);
});

test('the forms ask for a target folder, and normalize has an unchecked lowercase option (#257)', async (t) => {
  const { get, post } = await serve(t);
  for (const spec of organize.specs) {
    const body = await (await get(spec.path)).text();
    assert.match(body, /name="target"/, spec.path);
    assert.match(body, new RegExp(`action="${spec.path}/preview"`));
    assert.doesNotMatch(body, /checked/);
  }
  assert.match(await (await get('/organize/normalize')).text(), /name="includeLowercase"/);
  const empty = await post('/organize/flatten/preview', { target: '  ' });
  assert.strictEqual(empty.status, 400);
  assert.match(await empty.text(), /Enter a target folder/);
});

test('normalize: preview -> run -> result, same changes as the CLI (#257)', async (t) => {
  const { run } = await previewAndRun(t, { command: 'normalize', argv: ['normalize'], files: ['movie ABC-123.mp4', 'clip XYZ-777.mp4'] });
  assert.match(run.body, /<mark>ABC-123 movie<\/mark>\.mp4/);
  assert.match(run.body, /<h2>Renamed/);
});

test('normalize with the lowercase option follows --include-lowercase (#257)', async (t) => {
  const dir = makeTree(['movie abc-123.mp4']);
  const { post, finish } = await serve(t);
  const off = await finish(await post('/organize/normalize/preview', { target: dir }));
  assert.match(off.body, /<div class="value">0<\/div><div class="label">Renamed<\/div>/);
  const on = await finish(await post('/organize/normalize/preview', { target: dir, includeLowercase: 'on' }));
  assert.match(on.body, /ABC-123/);
  assert.deepStrictEqual(on.job.argv, ['normalize', dir, '--include-lowercase']);
  assert.match(on.body, /name="includeLowercase" value="on"/, 'the Run form carries the option');
  const run = await finish(await post('/organize/normalize/run', { target: dir, includeLowercase: 'on', fingerprint: fingerprintOf(on.body) }));
  assert.strictEqual(run.job.outcome.ran, true, run.body);
  assert.deepStrictEqual(fs.readdirSync(dir), ['ABC-123 movie.mp4']);
});

test('collapse: preview -> run -> result, same changes as the CLI (#257)', async (t) => {
  const { dir, run } = await previewAndRun(t, { command: 'collapse', argv: ['collapse'], files: ['Show/Show/Show/video.mp4'] });
  assert.match(run.body, /<h2>Collapsed/);
  assert.ok(fs.existsSync(path.join(dir, 'Show', 'video.mp4')));
});

test('product-number: preview -> run -> result, same changes as the CLI (#257)', async (t) => {
  const { dir, run } = await previewAndRun(t, { command: 'product-number', argv: ['product-number'], files: ['ABC-123/video.mp4'] });
  assert.match(run.body, /Found in the folder name/);
  assert.ok(fs.readdirSync(path.join(dir, 'ABC-123')).some((name) => name.startsWith('ABC-123 ')));
});

test('flatten: the preview shows the plan and the stale run changes nothing; no real run here because emptied folders go to the Recycle Bin (#257)', async (t) => {
  const dir = makeTree(['Show/CD1/video.mp4', 'Show/CD2/other.mp4']);
  const before = tree(dir);
  const { post, finish } = await serve(t);

  const preview = await finish(await post('/organize/flatten/preview', { target: dir }));
  assert.strictEqual(preview.job.mode, 'preview', preview.body);
  // The table is the same plan the CLI gives for a dry run.
  const direct = execute(['flatten', dir, '--dry-run']);
  assert.deepStrictEqual(preview.job.outcome.result.moved, JSON.parse(JSON.stringify(direct.result.moved)));
  assert.match(preview.body, /<mark>Show CD1<\/mark>\.mp4/);
  assert.match(preview.body, /Folder name used/);
  assert.match(preview.body, /Empty folders to the Recycle Bin/);
  assert.match(preview.body, /Emptied folders|Empty folders removed/);
  const first = fingerprintOf(preview.body);
  assert.ok(first);
  assert.deepStrictEqual(tree(dir), before);

  // The folder changes after the preview, so the run changes nothing and shows the new preview.
  fs.writeFileSync(path.join(dir, 'Show', 'CD1', 'extra.mp4'), 'x');
  const stale = await finish(await post('/organize/flatten/run', { target: dir, fingerprint: first }));
  assert.strictEqual(stale.job.outcome.repreview, true, stale.body);
  assert.match(stale.body, /folder changed after the preview/);
  assert.match(stale.body, /extra\.mp4/);
  assert.deepStrictEqual(tree(dir), [...before, path.join('Show', 'CD1', 'extra.mp4')].sort(), 'a stale run changes nothing');
  assert.notStrictEqual(fingerprintOf(stale.body), first);
});

test('a run request without a preview is refused for every command (#257)', async (t) => {
  const dir = makeTree(['a.mp4']);
  const { jobs, post } = await serve(t);
  for (const spec of organize.specs) {
    const res = await post(`${spec.path}/run`, { target: dir });
    assert.strictEqual(res.status, 400, spec.path);
    assert.match(await res.text(), /did not come from a preview/);
  }
  assert.strictEqual(jobs.running(), null);
});

test('a target inside the user folder is refused by the command and shown as an error (#257)', async (t) => {
  const { post, finish } = await serve(t);
  const home = path.join(FAKE_HOME, 'inside');
  const result = await finish(await post('/organize/collapse/preview', { target: home }));
  assert.strictEqual(result.job.status, 'error');
  assert.match(result.body, /Could not run/);
});

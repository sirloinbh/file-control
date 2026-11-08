'use strict';
// #173 실험용: CI(영어 Windows)에서 tar.exe가 어느 이름을 OEM 코드페이지로 바꾸는지 기록한다. 머지 전에 지운다.
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

test('codepage experiment (#173)', { skip: process.platform !== 'win32' }, () => {
  const cps = execFileSync('powershell.exe', ['-NoProfile', '-Command', "[Text.Encoding]::Default.CodePage; (Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage').OEMCP"], { encoding: 'utf8' }).trim().split(/\s+/);
  const out = { cps };
  const c = '¹';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpx-'));
  const p = (...parts) => path.join(dir, ...parts);
  const tar = (args) => { const r = spawnSync(path.join(process.env.SystemRoot, 'System32', 'tar.exe'), args, { encoding: 'latin1' }); return r.status === 0 ? 'ok' : `exit ${r.status} ${String(r.stderr).slice(0, 120)}`; };
  const names = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { recursive: true }).map((n) => n.split(path.sep).join('/')) : null);
  fs.mkdirSync(p('src', `t${c}`), { recursive: true });
  fs.writeFileSync(p('src', `n${c}.txt`), 'N');
  fs.writeFileSync(p('src', `t${c}`, 'a.txt'), 'A');
  fs.writeFileSync(p('src', 'plain.txt'), 'P');
  for (const ext of ['zip', 'jar', '7z', 'tar', 'tar.gz', 'tgz', 'tar.bz2', 'tar.xz', 'tar.zst', 'cpio', 'iso', 'ar', 'a', 'xar', 'shar', 'mtree', 'warc', 'gz', 'taZ', 'unknownext']) {
    const archive = p(`e.${ext}`);
    const made = tar(['-a', '-cf', archive, '-C', p('src'), `n${c}.txt`, `t${c}`]);
    const x = p(`x_${ext}`);
    fs.mkdirSync(x);
    const ex = made === 'ok' ? tar(['-xf', archive, '-C', x]) : '-';
    out[ext] = { made, ex, names: names(x) };
  }
  // 경로 인자: 압축 파일 경로, -C 폴더, 풀 폴더
  fs.mkdirSync(p(`d${c}`));
  fs.mkdirSync(p(`s${c}`));
  fs.writeFileSync(p(`s${c}`, 'b.txt'), 'B');
  for (const ext of ['zip', 'tar.gz', 'cpio']) {
    const archive = p(`d${c}`, `o${c}.${ext}`);
    const made = tar(['-a', '-cf', archive, '-C', p(`s${c}`), 'b.txt']);
    const dest = p(`out${c}_${ext}`);
    fs.mkdirSync(dest);
    const ex = tar(['-xf', archive, '-C', dest]);
    out[`path:${ext}`] = { made, archiveDir: names(p(`d${c}`)), ex, dest: names(dest), list: tar(['-tf', archive]) };
  }
  // 넘겨준 이름이 폴더 경로를 포함할 때(상위 폴더 이름이 항목 이름에 들어감)
  const made = tar(['-a', '-cf', p('rel.zip'), '-C', dir, `s${c}/b.txt`]);
  fs.mkdirSync(p('x_rel'));
  out.relzip = { made, ex: tar(['-xf', p('rel.zip'), '-C', p('x_rel')]), names: names(p('x_rel')) };
  process.stdout.write(`CPX ${JSON.stringify(out)}\n`);
});

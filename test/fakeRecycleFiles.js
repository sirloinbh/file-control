'use strict';

// 묶음 휴지통 이동(recycleFiles, FC_RECYCLE_FILES)을 흉내 낸다(#194, #216). 사용자 휴지통을 건드리지 않도록 테스트에서 쓴다.
// 실제 스크립트(RECYCLE_FILES_SCRIPT)처럼 줄마다 지우기 직전에 실제 경로·파일 여부·fileStamp를 보고,
// 남길 파일(keep)을 주면 그것도 다시 본 뒤 지운다. 실제 스크립트 자체는 test/recycle.test.js가 실제 PowerShell로 확인한다.
// target마다 hook(target, stamp)를 부르고 지운다. hook이 던지면 그 파일만 Windows 사유(error)로 실패한 것처럼 한다.

const fs = require('node:fs');

// src/target을 여기서 불러오면 commands.js가 테스트의 가짜 execFileSync보다 먼저 읽혀 진짜 함수를 받아 두므로, 쓸 때 불러온다.
const fileStamp = (stat) => require('../src/target').fileStamp(stat);

const decode = (encoded) => Buffer.from(encoded, 'base64').toString('utf16le');
const encode = (text) => Buffer.from(text, 'utf16le').toString('base64');

function same(file, stamp) {
  try {
    if (fs.realpathSync.native(file) !== file) return 'moved';
    const stat = fs.lstatSync(file, { bigint: true });
    if (!stat.isFile()) return 'notfile';
    return fileStamp(stat) === stamp ? 'ok' : 'changed';
  } catch {
    return 'gone';
  }
}

function fakeRecycleFiles(options, hook) {
  const lines = [];
  for (const line of options.input.split('\n').filter(Boolean)) {
    const [path, stamp, keepPath, keepStamp] = line.split(' ');
    const target = decode(path);
    let status = same(target, stamp);
    if (status === 'ok' && keepPath !== undefined && same(decode(keepPath), keepStamp) !== 'ok') status = 'keepchanged';
    if (status !== 'ok') {
      lines.push(`${status} ${path} `);
      continue;
    }
    try {
      hook(target, stamp);
      fs.rmSync(target);
      lines.push(`ok ${path} `);
    } catch (err) {
      lines.push(`error ${path} ${encode(err.message)}`);
    }
  }
  return lines.join('\r\n') + '\r\n';
}

module.exports = { fakeRecycleFiles };

'use strict';

const fs = require('node:fs');
const { FcError } = require('./commands');
const { fileSizeInside } = require('./target');

// 한 번에 읽을 수 있는 최대 길이. readRange와 같다.
const MAX_READ = 2 ** 31 - 1;

// 타겟 안의 파일을 한 번만 열고 그 핸들로 여러 번 읽는다(#90). 요소마다 경로를 확인하고 다시 열면 작은 요소가 많은 파일에서
// 읽기 한도에 닿기까지 수십 초가 걸린다. real은 grant의 read로 확인한 실제 경로다.
// 경로의 파일 번호(dev, ino)를 먼저 적어 두고, 경로를 확인한 뒤(타겟 안, 링크가 아닌 파일) 연다. 연 핸들의 파일 번호가 적어 둔 것과
// 다르면 확인과 열기 사이에 파일이 바뀌었거나 링크·정션으로 바뀐 것이라 읽지 않는다(1차 리뷰).
// 연 뒤에 경로가 바뀌어도 핸들은 처음 확인한 파일을 계속 읽는다. fn이 끝나면 닫는다.
function withOpenFile(target, real, fn) {
  const named = fs.statSync(real, { bigint: true });
  fileSizeInside(target, real);
  const fd = fs.openSync(real, 'r');
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.ino !== named.ino || opened.dev !== named.dev) throw new FcError(`The file changed while reading: ${real}`);
    const size = Number(opened.size);
    return fn({ size, read: (offset, length) => readAt(fd, size, offset, length) });
  } finally {
    fs.closeSync(fd);
  }
}

// offset부터 length바이트를 읽는다. 파일 끝을 넘는 부분은 읽지 않으므로 돌려준 길이가 더 짧을 수 있다.
function readAt(fd, size, offset, length) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new FcError(`Invalid offset: ${offset}`);
  if (!Number.isSafeInteger(length) || length < 0) throw new FcError(`Invalid length: ${length}`);
  if (length > MAX_READ) throw new FcError(`Exceeds the length that can be read at once (${MAX_READ} bytes): ${length}`);
  const buffer = Buffer.alloc(Math.min(length, Math.max(0, size - offset)));
  let read = 0;
  while (read < buffer.length) {
    const n = fs.readSync(fd, buffer, read, buffer.length - read, offset + read);
    if (n === 0) break;
    read += n;
  }
  return buffer.subarray(0, read);
}

module.exports = { withOpenFile };

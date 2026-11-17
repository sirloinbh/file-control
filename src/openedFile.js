'use strict';

const fs = require('node:fs');
const { FcError } = require('./commands');
const { fileSizeInside } = require('./target');

// The maximum length that can be read at once. The same as readRange.
const MAX_READ = 2 ** 31 - 1;

// It opens a file inside the target only once and reads several times with that handle (#90). If it checked the path and reopened for each element, a file with many small elements
// would take tens of seconds to reach the read limit. real is the real path confirmed with the read of grant.
// It first writes down the path's file ID (dev, ino) and opens after checking the path (inside the target, a file that is not a link). If the opened handle's file ID is
// different from the written one, the file changed or was replaced by a link or junction between the check and the open, so it does not read (first review).
// Even if the path changes after opening, the handle keeps reading the file first confirmed. It closes when fn ends.
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

// It reads length bytes from offset. It does not read the part past the end of the file, so the returned length can be shorter.
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

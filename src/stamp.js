'use strict';

const childProcess = require('node:child_process');
const path = require('node:path');

// A value for comparing whether the file is unchanged. It takes the lstat result received as bigint. Even if the modification time is set back, the change time (ctime) differs.
function fileStamp(stat) {
  return [stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

// File systems that do not record the change time (ctime). On exFAT the change time of every file comes out as the same value (#120),
// so a file rewritten with the same size and with the modification time set back cannot be recognized by fileStamp and the 5-minute protection (#184).
const NO_CHANGE_TIME = new Set(['FAT', 'FAT12', 'FAT16', 'FAT32', 'EXFAT']);
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

// The file system name (NTFS, ReFS, exFAT, and so on) of the volume where the target is. If it cannot be confirmed, it is null.
// It looks at the volume of the drive letter. Under a volume mount folder, the value of the drive where that folder lives comes out.
function volumeFormat(target) {
  if (process.platform !== 'win32') return null;
  const script = '[IO.DriveInfo]::new([IO.Path]::GetPathRoot($env:FC_FORMAT_VOLUME)).DriveFormat';
  try {
    // It is looked up in the module on every call so that tests can intercept it.
    const output = childProcess.execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, FC_FORMAT_VOLUME: path.resolve(target) },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 60 * 1000,
    });
    const found = /^(\w+)\s*$/.exec(String(output));
    return found ? found[1] : null;
  } catch {
    return null;
  }
}

// If it is a volume where a swap cannot be recognized by fileStamp, it returns the reason for not deleting; if it can be recognized, null.
// Even if the file system cannot be confirmed, it does not delete.
function stampVolumeReason(target) {
  const format = volumeFormat(target);
  if (format === null) return 'Kept because the file system could not be checked, so a file changed after the check could not be detected.';
  if (NO_CHANGE_TIME.has(format.toUpperCase())) return `Kept because ${format} volumes do not record change times, so a file changed to the same size after the check could not be detected.`;
  return null;
}

module.exports = { fileStamp, volumeFormat, stampVolumeReason };

'use strict';

// The file commands. The code lives in base.js, recycle.js, fsOps.js and archive.js; this file only re-exports it, so callers do not change (#315).

const pick = (mod, names) => Object.fromEntries(names.map((name) => [name, mod[name]]));
const base = require('./base');
const recycle = require('./recycle');
const fsOps = require('./fsOps');
const archive = require('./archive');

module.exports = {
  ...pick(base, [
    'rejectHardLinkedWrite', 'FcError', 'perform',
  ]),
  ...pick(recycle, [
    'remove', 'recycleBinState', 'permanentDeleteReason', 'UNKNOWN_RECYCLE_LIMIT', 'RECYCLE_STATE_SCRIPT', 'RECYCLE_SCRIPT', 'previewRefusal',
    'sizeUpTo', 'hiddenOrSystemEntries', 'recycleEmptyFolders', 'RECYCLE_FOLDERS_SCRIPT', 'recycleFiles', 'RECYCLE_FILES_SCRIPT', 'permanentRefusal',
    'recycleFailureMessage', 'bareDeviceInside', 'MAX_RECYCLE_PATH', 'decodeReason', 'busyInside', 'recycleTarget',
  ]),
  ...pick(fsOps, [
    'formatSize', 'list', 'makeDir', 'writeFile', 'readFile', 'rename', 'move', 'copy', 'resolveDest', 'freshPath',
  ]),
  ...pick(archive, [
    'unzip', 'archiveEntries', 'archiveNames', 'probeArchive', 'archiveExt', 'FORMAT_LABELS', 'COMPRESS_LABELS', 'TAR_COMPRESS', 'unsupportedChars', 'oemCodePage', 'couldBeShortNameOf',
    'rejectExtractShortNameClash', 'ensureRoomToExtract', 'freeSpace', 'SPACE_RESERVE', 'MAX_TAR_DIR', 'TEMP_SERIAL_RESERVE', 'missingProgram', 'zip',
  ]),
};

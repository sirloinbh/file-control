'use strict';

// Test helpers for the removal records that remove-* commands write into the change journal (#415).
const fs = require('node:fs');
const path = require('node:path');
const journal = require('../src/journal');

// The journal files of the runs that wrote a removal record for this target folder (newest first).
function logs(dir) {
  const target = fs.realpathSync.native(dir);
  return journal.listJournals().filter((file) => {
    const read = journal.readJournal(file);
    return read.removal !== undefined && path.resolve(read.removal.target).toLowerCase() === target.toLowerCase();
  });
}

// The removal record of one journal file, with the outcomes written later merged into its items.
function readRecord(file) {
  const read = journal.readJournal(file);
  const record = JSON.parse(JSON.stringify(read.removal));
  for (const update of read.outcomes ?? []) {
    const { index, ...rest } = update;
    Object.assign(record.items[index], rest);
  }
  return record;
}

module.exports = { logs, readRecord };

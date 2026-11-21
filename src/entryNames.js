'use strict';

// It checks that each archive entry was extracted under its original name and size (shared by extract.js and the tar.gz scan process, #324).
const fs = require('node:fs');
const path = require('node:path');

// tar.exe turns a name with these characters into _ or drops the front part.
const CHANGED_NAME = /[:?*<>|"\x00-\x1f]/;

// Even if the content remains, the name may exist only in the original.
// The preview has no extracted result, so it looks only at the name letters. If there is no size, it does not look at the size.
function checkEntryNames(entries, dest, dryRun) {
  for (const { name, size } of entries) {
    if (CHANGED_NAME.test(name)) return `Kept because an item would get a different name when extracted: ${JSON.stringify(name)}`;
    const relative = name.replaceAll('\\', '/').replace(/^(?:\.\/)+/, '');
    const folder = relative === '' || relative.endsWith('/');
    if (folder && size > 0) return `Kept because a folder entry has content: ${JSON.stringify(name)}`;
    if (dryRun) continue;
    const stat = fs.lstatSync(path.join(dest, relative), { throwIfNoEntry: false });
    if (!stat) return `Kept because an item was not extracted under the same name: ${JSON.stringify(name)}`;
    if (folder ? !stat.isDirectory() : size !== undefined && (!stat.isFile() || stat.size !== size)) return `Kept because the extracted size differs: ${JSON.stringify(name)}`;
  }
  return null;
}

module.exports = { checkEntryNames };

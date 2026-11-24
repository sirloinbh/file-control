'use strict';

// sort-docs (#390): documents go into folders by document type. It builds its plan with the shared sort engine (src/sort.js); files that are not documents are left alone.
const path = require('node:path');
const { FcError } = require('./commands');
const { planSortWith, applySort, monthFolder } = require('./sort');

const extensions = (list) => new Set(list.split(' '));

// The document type table. Folder names are the ones the user sees.
const DOC_TYPES = [
  ['PDF', extensions('.pdf')],
  ['Word', extensions('.doc .docx .docm .dot .dotx')],
  ['Excel', extensions('.xls .xlsx .xlsm .xlsb .csv')],
  ['Slides', extensions('.ppt .pptx .pptm .pps .ppsx')],
  ['HWP', extensions('.hwp .hwpx')],
  ['Text', extensions('.txt .md')],
  ['Other documents', extensions('.rtf .odt .ods .odp .epub')],
];

// The type folder of a file name, or undefined when it is not a document.
function docFolder(name) {
  const ext = path.extname(name).toLowerCase();
  return DOC_TYPES.find(([, set]) => set.has(ext))?.[0];
}

// by: undefined (type folders only) or 'month' (a month folder inside each type folder, like PDF/2026-11).
function sortDocs(dir, { by, dryRun = false, recursive = false } = {}) {
  if (by !== undefined && by !== 'month') throw new FcError('sort-docs accepts only --by=month.');
  const rule = (file) => {
    const folder = docFolder(file.name);
    if (folder === undefined) return { ignore: true };
    return { folder: by === 'month' ? `${folder}/${monthFolder(file.stat.mtime)}` : folder };
  };
  return { by, ...applySort(planSortWith(dir, rule, { recursive }), { dryRun }) };
}

module.exports = { DOC_TYPES, docFolder, sortDocs };

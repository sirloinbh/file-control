'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { FcError, remove, freshPath, hiddenOrSystemEntries } = require('./commands');
const { grant, walk } = require('./target');
const { extractProductNumbers } = require('./product');
const { containsNumber, VIDEO_EXTENSIONS, TRANSPORT_EXTENSIONS } = require('./productName');
const { LEFTOVER, SYSTEM_FOLDER, moveWithoutOverwrite, rejectRepository } = require('./flatten');

// It collects the items directly under each folder. The key of the target itself is ''.
function childrenOf(entries) {
  const children = new Map();
  for (const entry of entries) {
    const parent = path.dirname(entry.relative);
    const key = parent === '.' ? '' : parent;
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(entry);
  }
  return children;
}

// If a folder holds only one folder, it returns that folder item.
function soleFolder(children, relative) {
  const inside = children.get(relative) ?? [];
  return inside.length === 1 && inside[0].type === 'dir' ? inside[0] : null;
}

const under = (entry, folder) => entry.relative.startsWith(folder.relative + path.sep);
const hasPart = (entry, pattern) => entry.relative.split(path.sep).some((part) => pattern.test(part));

// .ts and .mts cannot be known to be video before looking at the content, so they are treated as video to stay on the safe side.
function isVideoName(name) {
  const extension = path.extname(name).toLowerCase();
  return VIDEO_EXTENSIONS.has(extension) || TRANSPORT_EXTENSIONS.has(extension);
}

// The reason it cannot be collapsed. If it may be collapsed, it is null.
function skipReason(chain, entries) {
  const leaf = chain.at(-1);
  const inside = entries.filter((entry) => under(entry, leaf));
  // The bottom folder is moved as a whole, so the leftovers and system folders inside it go along. They must be at the location the message told in order to be recovered.
  if (inside.some((entry) => hasPart(entry, LEFTOVER))) return 'Not collapsed because there is a leftover from an earlier job inside.';
  if (inside.some((entry) => hasPart(entry, SYSTEM_FOLDER))) return 'Not collapsed because a Windows system folder is involved.';
  // Collapsing removes the middle folder names. product-number looks for the number in those names, so it counts as fine if only a number that is already in the file names disappears.
  // It must be in all the videos if there are videos, and in all the files if there are none. If it is in only one cover file, the other videos lose the number.
  const kept = new Set(extractProductNumbers(path.basename(chain[0].path)));
  const files = inside.filter((entry) => entry.type !== 'dir').map((entry) => path.basename(entry.path));
  const videos = files.filter((name) => isVideoName(name));
  const named = videos.length > 0 ? videos : files;
  const lost = chain.slice(1).flatMap((entry) => extractProductNumbers(path.basename(entry.path))).filter((number) => !kept.has(number) && !named.every((name) => containsNumber(name, number)));
  if (lost.length > 0) return `Collapsing would lose the product number in the folder name: ${[...new Set(lost)].join(', ')}. Put it in the file name and run again. product-number adds it to video files.`;
  return null;
}

// When collapsing, the bottom folder is moved to the top name, so the folder attributes (hidden and so on) and the ACL become those of the bottom folder (#85).
// Node has no API that writes attributes, rewriting with attrib after the move leaves a half-changed state when it fails, and the ACL cannot be moved.
// So it does not match the attributes, and it does not collapse if any folder in the stretch is hidden. If the top is hidden the hiding is lifted,
// if the bottom is hidden the top name becomes hidden and looks gone in Explorer, and if a middle one is hidden its inside is exposed.
// The system attribute is used with the folder icon (desktop.ini), and the only folder that holds desktop.ini is the bottom folder, which moves along, so it is not blocked.
// attributes is the { relative path -> attribute bits (hidden 2, system 4) } returned by hiddenOrSystemEntries.
function hiddenReason(chain, attributes) {
  const hidden = chain.filter((entry) => (attributes.get(entry.relative) ?? 0) & 2);
  if (hidden.length === 0) return null;
  return `Not collapsed because a folder has the hidden attribute (collapsing would give the folder attributes of the bottom folder): ${hidden.map((entry) => entry.relative).join(', ')}`;
}

// Finds stretches under the target where each folder holds only one folder. It keeps the top folder name and lifts the content of the bottom folder to that place.
// It does not collapse the target itself. If a level has several items, it looks separately from below it. A stretch that ends in an empty folder may be a structure the user made, so it is not touched.
// - collapses: the stretches to collapse ({ top, leaf, folders }). folders is the path from the top to the bottom. They are placed deepest first so that an earlier operation does not change a later path.
// - skipped: stretches not collapsed ({ path, reason })
function planCollapse(dir) {
  const access = grant(dir, ['read', 'write', 'delete']);
  const entries = walk(access.target);
  rejectRepository(access.target, entries);
  const children = childrenOf(entries);
  const plan = { target: access.target, collapses: [], skipped: [] };
  // The stretches whose attributes are to be looked at. To keep the order of skipping, an empty reason is placed at that position and filled in later.
  const pending = [];
  for (const entry of entries) {
    if (entry.type !== 'dir') continue;
    // For leftovers, it reports only the topmost one and does not look inside. A file that could not be restored may be here.
    if (hasPart(entry, LEFTOVER)) {
      if (LEFTOVER.test(path.basename(entry.path)) && !hasPart({ relative: path.dirname(entry.relative) }, LEFTOVER)) plan.skipped.push({ path: entry.path, reason: 'Not collapsed because it is a leftover from an earlier job.' });
      continue;
    }
    if (!soleFolder(children, entry.relative)) continue;
    const parent = path.dirname(entry.relative);
    // If the folder above holds only this one folder, it goes into the stretch on the folder-above side.
    if (parent !== '.' && soleFolder(children, parent)) continue;
    const chain = [entry];
    for (let next = soleFolder(children, entry.relative); next; next = soleFolder(children, next.relative)) chain.push(next);
    if (!children.has(chain.at(-1).relative)) continue;
    const reason = skipReason(chain, entries);
    if (reason !== null) {
      plan.skipped.push({ path: entry.path, reason });
      continue;
    }
    const slot = { path: entry.path, reason: null };
    plan.skipped.push(slot);
    pending.push({ chain, slot });
  }
  // The attributes are read with one PowerShell run only when there is a stretch to collapse. To know the attributes of the stretch folders it is enough to enumerate their parents, so
  // it passes only the parent of the top folder and the stretch folders without the bottom one. Many folders unrelated to the stretch do not slow it down (first review).
  const listed = new Set();
  for (const { chain } of pending) {
    const parent = path.dirname(chain[0].relative);
    listed.add(parent === '.' ? '' : parent);
    for (const item of chain.slice(0, -1)) listed.add(item.relative);
  }
  const attributes = pending.length > 0 ? hiddenOrSystemEntries(access.target, [...listed]) : new Map();
  for (const { chain, slot } of pending) {
    slot.reason = hiddenReason(chain, attributes);
    if (slot.reason !== null) continue;
    try {
      const folders = chain.map((item) => item.path);
      // Stretches that cannot be handled, such as a folder that holds a link or a name ending in a dot, are reported in the plan. The results of a real run and a preview become the same.
      for (const folder of folders) {
        if (access.delete(folder) !== folder) throw new FcError(`The path goes through a link: ${folder}`);
      }
      plan.collapses.push({ top: folders[0], leaf: folders.at(-1), folders });
    } catch (err) {
      if (!(err instanceof FcError)) throw err;
      slot.reason = err.message;
    }
  }
  const slots = new Set(pending.map(({ slot }) => slot));
  plan.skipped = plan.skipped.filter((item) => !slots.has(item) || item.reason !== null);
  plan.collapses.sort((a, b) => b.leaf.split(path.sep).length - a.leaf.split(path.sep).length);
  return plan;
}

// If another item appeared in the stretch after the plan, it would be cleared together with the empty folders, so it stops.
function checkChain(item, access) {
  for (const [index, folder] of item.folders.entries()) {
    const real = access.delete(folder);
    if (real !== folder) throw new FcError(`The path changed after planning: ${folder} -> ${real}`);
    if (!fs.lstatSync(real).isDirectory()) throw new FcError(`No longer a folder after planning: ${real}`);
    if (index === item.folders.length - 1) break;
    const inside = fs.readdirSync(real);
    if (inside.length !== 1 || inside[0] !== path.basename(item.folders[index + 1])) throw new FcError(`The folder content changed after planning: ${real}`);
  }
}

// It rolls back the renames done earlier. For items that could not be rolled back, it tells where all of them are.
// renameSync overwrites if the target is a file, so it uses a move that does not overwrite.
function restore(steps, cause) {
  const left = [];
  for (const [from, to] of steps) {
    try {
      if (!moveWithoutOverwrite(from, to)) left.push(`${from} -> ${to} (EEXIST)`);
    } catch (err) {
      left.push(`${from} -> ${to} (${err.code ?? err.message})`);
    }
  }
  if (left.length > 0) throw new FcError(`Could not collapse and could not undo it either. (${cause.code ?? cause.message}) ${left.join(', ')}`);
}

// The whole folder is renamed, so even if the name of an inner item is the same as a middle folder name, they do not collide.
// After pulling out the bottom folder, it clears the top folder that became empty and moves the bottom folder under that name.
function collapseOne(item, access) {
  checkChain(item, access);
  const lifted = freshPath(item.top, '.fctl-new');
  const emptied = freshPath(item.top, '.fctl-old');
  fs.renameSync(item.leaf, lifted);
  try {
    fs.renameSync(item.top, emptied);
  } catch (err) {
    restore([[lifted, item.leaf]], err);
    throw err;
  }
  try {
    // In the meantime another program may have taken the top name.
    if (!moveWithoutOverwrite(lifted, item.top)) throw Object.assign(new Error('taken'), { code: 'EEXIST' });
  } catch (err) {
    restore([[emptied, item.top], [lifted, item.leaf]], err);
    throw err;
  }
  return emptied;
}

// It sends only empty folders to the Recycle Bin. If there are files, it does not delete.
function removeEmptied(emptied) {
  const filled = fs.readdirSync(emptied, { recursive: true, withFileTypes: true }).find((entry) => !entry.isDirectory());
  if (filled) throw new FcError(`Collapsed, but not deleted because the emptied folder contains files: ${emptied}`);
  remove([emptied]);
}

function emptiedFailure(emptied, err) {
  if (err instanceof FcError && err.message.startsWith('Collapsed, but')) return err.message;
  return `Collapsed, but could not send the empty folder to the Recycle Bin: ${emptied} (${err instanceof FcError ? err.message : err.code ?? err.status})`;
}

// It collapses stretches where each folder holds only one folder. It does not overwrite, and even if one stretch fails, it continues with the rest.
// The returned value is { target, dryRun, collapsed, skipped, failed }. collapsed is the planned stretch plus the final location dest, and failed is a list of { path, reason }.
function collapse(dir, options = {}) {
  return applyCollapse(planCollapse(dir), options);
}

// If a collapsed stretch contains a path, that path also moves along. The stretches are taken in the order they were collapsed.
function finalPath(p, collapsed) {
  let dest = p;
  for (const item of collapsed) {
    if (dest === item.leaf || dest.startsWith(item.leaf + path.sep)) dest = item.top + dest.slice(item.leaf.length);
  }
  return dest;
}

// The report writes the final location that reflects the upper stretches collapsed later.
function withFinalPaths(result, collapsed) {
  return {
    ...result,
    collapsed: collapsed.map((item, index) => ({ ...item, dest: finalPath(item.top, collapsed.slice(index + 1)) })),
    skipped: result.skipped.map((item) => ({ ...item, path: finalPath(item.path, collapsed) })),
  };
}

function applyCollapse(plan, { dryRun = false } = {}) {
  const result = { target: plan.target, dryRun, collapsed: [], skipped: plan.skipped, failed: [] };
  if (dryRun) return withFinalPaths(result, plan.collapses);
  const access = grant(plan.target, ['read', 'write', 'delete']);
  for (const item of plan.collapses) {
    // If an inner stretch failed, the location the message told must stay as it is in order to be recovered, so it does not move the stretch that contains it.
    if (result.failed.some((failure) => failure.path === item.leaf || failure.path.startsWith(item.leaf + path.sep))) {
      result.failed.push({ path: item.top, reason: 'Not collapsed because an inner section failed.' });
      continue;
    }
    let emptied;
    try {
      emptied = collapseOne(item, access);
      result.collapsed.push(item);
    } catch (err) {
      result.failed.push({ path: item.top, reason: err instanceof FcError ? err.message : `Could not collapse. (${err.code})` });
      continue;
    }
    try {
      removeEmptied(emptied);
    } catch (err) {
      result.failed.push({ path: item.top, reason: emptiedFailure(emptied, err) });
    }
  }
  return withFinalPaths(result, result.collapsed);
}

function formatCollapse(result) {
  const relative = (p) => path.relative(result.target, p) || '.';
  const prefix = result.dryRun ? '[Preview] ' : '';
  const lines = [];
  for (const item of result.collapsed) lines.push(`${prefix}Collapse: ${relative(item.leaf)} -> ${relative(item.dest)}`);
  for (const item of result.skipped) lines.push(`${prefix}Skipped: ${relative(item.path)} (${item.reason})`);
  for (const item of result.failed) lines.push(`Failed: ${relative(item.path)} (${item.reason})`);
  lines.push(`${prefix}Collapse ${result.collapsed.length}, skipped ${result.skipped.length}, failed ${result.failed.length}`);
  return lines.join('\n');
}

module.exports = { planCollapse, applyCollapse, collapse, formatCollapse };

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const names = require('../src/flattenNames');

// Each rule is a table of [arguments, expected result]. The tables pin the heuristics that flatten uses to name files.
function table(title, fn, rows) {
  test(title, () => {
    for (const [args, expected] of rows) {
      assert.deepStrictEqual(fn(...args), expected, `${fn.name}(${JSON.stringify(args)})`);
    }
  });
}

table('stripExtension removes the extension only when the folder name ends with it, ignoring case', names.stripExtension, [
  [['ABC-123.MP4', '.mp4'], 'ABC-123'],
  [['ABC-123.mp4', '.mp4'], 'ABC-123'],
  [['Show', '.mp4'], 'Show'],
  [['Show.zip', '.mp4'], 'Show.zip'],
]);

table('hasNoUsableExtension flags names a folder name cannot be joined to', names.hasNoUsableExtension, [
  [['video.mp4'], false],
  [['video.en.srt'], false],
  [['noextension'], true],
  [['.env.local'], true],
  [['backup.tar.gz'], true],
  [['Dr. Strange'], true],
]);

table('informativeFolder accepts product numbers and real words, not generic folder names', names.informativeFolder, [
  [['ABC-123'], true],
  [['Summer Trip'], true],
  [['Downloads (2)'], false],
  [['새 폴더'], false],
  [['New folder - Copy'], false],
  [['1080p'], false],
  [['a'], false],
]);

table('titleFolder rejects subtitle folders but accepts titles that mention subs', names.titleFolder, [
  [['Show'], true],
  [['English Subs'], false],
  [['Movie [Eng Sub]'], true],
]);

table('distinguishingFolder also accepts quality-only names but not container names', names.distinguishingFolder, [
  [['1080p'], true],
  [['WEB-DL'], true],
  [['CD1'], true],
  [['Subs'], false],
  [['새 폴더'], false],
]);

table('subtitleFolder needs a subtitle word and nothing but subtitle and language words', names.subtitleFolder, [
  [['Subs'], true],
  [['Eng Sub'], true],
  [['자막'], true],
  [['English'], false],
  [['Movie [Eng Sub]'], false],
]);

table('languageFolder accepts only language names', names.languageFolder, [
  [['English'], true],
  [['한국어'], true],
  [['English Subs'], false],
  [['Show'], false],
]);

table('titleStart points after the outermost subtitle folder', names.titleStart, [
  [[['English Subs', 'Show']], 1],
  [[['Show', 'Subs']], 2],
  [[['Show', 'Season 1']], 0],
]);

table('words splits on separators and ignores case', names.words, [
  [['Show_2021 (HD)'], ['SHOW', '2021', 'HD']],
  [[''], []],
]);

table('containsWords matches consecutive whole words only', names.containsWords, [
  [[['SHOW', 'CD1'], 'SHOWCD1'], true],
  [[['MOVIE'], 'V'], false],
  [[['2021'], '2'], false],
]);

table('detailedName takes the most detailed folder name and keeps the extension', names.detailedName, [
  [['video.mp4', ['ABC-123']], 'ABC-123.mp4'],
  [['x.mp4', ['ABC-123 Title']], 'ABC-123 Title.mp4'],
  [['video.mp4', ['summer-2023']], 'summer-2023.mp4'],
  [['video.mp4', ['ABC-123.mp4']], 'ABC-123.mp4'],
  [['video.mp4', ['Show.zip']], 'video.mp4'],
  [['ep1.mp4', ['Show']], 'ep1.mp4'],
  [['backup.tar.gz', ['ABC-123']], 'backup.tar.gz'],
  [['noextension', ['ABC-123']], 'noextension'],
]);

table('prefixedName prepends the nearest usable folder to a name with no information', names.prefixedName, [
  [['video.mp4', ['ABC-123']], 'ABC-123 video.mp4'],
  [['video.en.srt', ['ABC-123']], 'ABC-123 video.en.srt'],
  [['sample.mp4', ['1080p', 'ABC-123']], 'ABC-123 1080p sample.mp4'],
  [['video.mp4', ['Show']], 'Show video.mp4'],
  [['ep1.mp4', ['Show']], 'ep1.mp4'],
  [['video.mp4', []], 'video.mp4'],
  [['.hidden', ['ABC-123']], '.hidden'],
]);

table('withOuterFolder prepends the outer title unless the name already has one', names.withOuterFolder, [
  [['video.mp4', 'CD1.mp4', ['Show']], 'Show CD1.mp4'],
  [['video.mp4', 'ABC-123 CD1.mp4', ['Show']], 'ABC-123 CD1.mp4'],
  [['ep1.mp4', 'ep1.mp4', ['Show']], 'ep1.mp4'],
]);

table('outerFolders returns the folders outside the chosen one', names.outerFolders, [
  [['video.mp4', 'CD1.mp4', ['CD1', 'Show'], 1], ['Show']],
  [['video.mp4', 'video.mp4', ['CD1', 'Show'], 1], ['Show']],
]);

table('joinBetween attaches distinguishing folders and stops at a subtitle folder', names.joinBetween, [
  [['Show', ['1080p', 'CD1']], 'Show CD1 1080p'],
  [['Show', ['Subs', 'CD1']], 'Show CD1'],
  [['Show', ['Show']], 'Show'],
]);

table('withTags puts the tag after the part before the first dot, or before the extension', names.withTags, [
  [['Show video.en.srt', 'video.en.srt', ['Forced']], 'Show video.Forced.en.srt'],
  [['Show Season 1.srt', 'video.srt', ['Forced']], 'Show Season 1.Forced.srt'],
  [['Show video.en.srt', 'video.en.srt', ['Forced', 'Full']], 'Show video.Forced.Full.en.srt'],
]);

'use strict';

// 압축 화면(#258)의 순수 부분: zip 형식 미리보기와 extract-all 결과 표.
// 형식은 tar.exe -a가 압축 파일 이름의 확장자로 정한다. 어떤 확장자를 옮기는지는 commands.archiveExt를 그대로 쓴다.

const path = require('node:path');
const { archiveExt } = require('../commands');
const { html } = require('./html');
const { summaryCards, badge, table } = require('./layout');

// 형식으로 읽는 확장자(#164 FORMAT_EXT와 tar).
const FORMAT_LABELS = {
  tar: 'tar',
  zip: 'ZIP',
  '7z': '7z',
  cpio: 'cpio',
  iso: 'ISO 9660',
  ar: 'ar',
  shar: 'shar',
  xar: 'xar',
  warc: 'WARC',
  mtree: 'mtree',
};
// 압축 겹으로 읽는 확장자. .Z(대문자)만 compress이고 .z는 압축으로 보지 않는다.
const COMPRESS_LABELS = {
  gz: 'gzip', bz2: 'bzip2', xz: 'xz', zst: 'zstd', lzma: 'lzma', lz: 'lzip', lz4: 'lz4', lzo: 'lzop', lrz: 'lrzip', grz: 'grzip', uu: 'uuencode', Z: 'compress',
};
// tar와 압축을 함께 뜻하는 확장자. .taz는 gzip, .taZ·.tZ는 compress다(대소문자로 갈림).
const TAR_COMPRESS = {
  tgz: 'gzip', taz: 'gzip', tbz: 'bzip2', tbz2: 'bzip2', tz2: 'bzip2', txz: 'xz', tlz: 'lzma', tzst: 'zstd', tzo: 'lzop', taZ: 'compress', tZ: 'compress',
};

const compressKey = (part) => (part === 'Z' ? 'Z' : part.toLowerCase());
const tarCompressKey = (part) => (part === 'taZ' || part === 'tZ' ? part : part.toLowerCase());

// 압축 파일 이름으로 만들어질 형식을 설명한다. { ext, format, layers, label }
// format은 묶음 형식(tar, ZIP 등), layers는 바깥으로 갈수록 뒤에 오는 압축 겹이다.
function describeArchiveFormat(name) {
  const ext = archiveExt(String(name));
  const parts = ext.split('.').filter(Boolean);
  const layers = [];
  let format = null;
  // 끝에서부터 압축 겹을 벗긴다.
  let i = parts.length - 1;
  while (i >= 0) {
    const part = parts[i];
    if (COMPRESS_LABELS[compressKey(part)]) {
      layers.unshift(COMPRESS_LABELS[compressKey(part)]);
      i -= 1;
    } else if (TAR_COMPRESS[tarCompressKey(part)]) {
      layers.unshift(TAR_COMPRESS[tarCompressKey(part)]);
      format = 'tar';
      i -= 1;
      break;
    } else {
      break;
    }
  }
  if (format === null && i >= 0) format = FORMAT_LABELS[parts[i].toLowerCase()] ?? null;
  const unknown = format === null && i >= 0 ? parts[i] : null;
  if (format === null) format = 'tar';
  const plain = layers.length === 0 && format === 'tar';
  let label = [format, ...layers].join(' + ');
  if (plain) label = 'tar (압축 없음)';
  if (unknown !== null) label += ` - .${unknown}는 형식으로 읽지 않는 확장자입니다`;
  else if (ext === '') label += ' - 확장자가 없습니다';
  return { ext, format, layers, label };
}

const relativeTo = (target) => (p) => path.relative(target, p) || '.';

// extract-all 결과 화면. 압축 파일마다 한 줄: 결과, 풀린 폴더, 항목 수, 원본 처리·사유.
// outcome.result는 extractArchives의 결과를 JSON으로 옮긴 것이다.
function extractAllView(outcome) {
  const result = outcome.result;
  const rel = relativeTo(result.target);
  const prefix = result.dryRun ? '풀 예정' : '풀림';
  const removed = new Set(result.removed);
  const kept = new Map(result.kept.map((item) => [item.archive, item.reason]));
  // 풀었지만 원본을 휴지통으로 보내지 못한 것은 failed에도 나온다. 그 줄은 풀린 줄의 원본 칸에 합친다.
  const extracted = new Set(result.extracted.map((item) => item.archive));
  const removalFailed = new Map(result.failed.filter((item) => extracted.has(item.archive)).map((item) => [item.archive, item.reason]));
  const rows = [];
  for (const item of result.extracted) {
    let original = '그대로 둠';
    if (removed.has(item.archive)) original = badge('done', result.dryRun ? '휴지통으로 보낼 예정' : '휴지통으로 보냄');
    else if (kept.has(item.archive)) original = html`${badge('kept')} ${kept.get(item.archive)}`;
    else if (removalFailed.has(item.archive)) original = html`${badge('failed', '원본 처리 실패')} ${removalFailed.get(item.archive)}`;
    rows.push([rel(item.archive), badge('done', prefix), rel(item.dest), String(item.entries), original]);
  }
  for (const item of result.failed) {
    if (!removalFailed.has(item.archive)) rows.push([rel(item.archive), badge('failed'), '', '', item.reason]);
  }
  for (const item of result.skipped) rows.push([rel(item.path), badge('skipped'), '', '', item.reason]);

  const cards = [
    { label: result.dryRun ? '풀 압축 파일' : '푼 압축 파일', value: result.extracted.length, tone: 'ok' },
    ...(result.removeArchives ? [{ label: result.dryRun ? '휴지통으로 보낼 원본' : '휴지통으로 보낸 원본', value: result.removed.length }, { label: '남긴 원본', value: result.kept.length }] : []),
    { label: '건너뜀', value: result.skipped.length },
    { label: '실패', value: result.failed.length, tone: result.failed.length > 0 ? 'error' : undefined },
  ];
  return html`<p>타겟: <code>${result.target}</code>${result.dryRun ? ' (미리보기: 아직 아무것도 바꾸지 않았습니다)' : ''}</p>
${summaryCards(cards)}
${table([{ label: '압축 파일', width: '28%' }, { label: '결과', width: '14%' }, { label: '풀린 폴더', width: '24%' }, { label: '항목', width: '8%' }, { label: '원본·사유' }], rows, { empty: '압축 파일이 없습니다.' })}`;
}

module.exports = { describeArchiveFormat, extractAllView };

'use strict';

const { FcError } = require('./commands');
const { grant, readRange, fileSizeInside } = require('./target');

// 파일 맨 앞에 올 수 있는 박스. ftyp이 없는 옛 QuickTime 파일도 받으려고 여러 개를 둔다.
const FIRST_BOXES = new Set(['ftyp', 'styp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pnot']);

// 손상된 파일이 작은 박스를 끝없이 늘어놓아도 읽기 횟수가 한없이 늘지 않게 한다. 정상 파일은 수십 번이면 끝난다.
const MAX_READS = 20000;
// 제목·코멘트 값의 최대 크기. 더 크면 없는 값으로 본다. 표지 이미지 같은 큰 값은 메모리에 올리지 않는다.
const MAX_TEXT = 64 * 1024;

// 제목은 iTunes 형식, QuickTime 키, 옛 QuickTime, 3GPP 순으로 고른다. 코멘트도 같은 순서이고 같은 형식 안에서는 왼쪽이 먼저다.
const TITLE_SOURCES = ['ilst:©nam', 'mdta:com.apple.quicktime.title', 'udta:©nam', 'udta:titl'];
const COMMENT_SOURCES = [
  'ilst:©cmt',
  'ilst:desc',
  'ilst:ldes',
  'mdta:com.apple.quicktime.comment',
  'mdta:com.apple.quicktime.description',
  'udta:©cmt',
  'udta:dscp',
];

const fourcc = (buffer, offset = 0) => buffer.toString('latin1', offset, offset + 4);

// offset부터 length바이트를 읽고, 모자라면 손상으로 본다. 읽기 횟수도 여기서 센다.
function makeReader(target, real, p) {
  let reads = 0;
  return (offset, length) => {
    reads += 1;
    if (reads > MAX_READS) throw new FcError(`MP4 박스가 너무 많아 읽기를 멈췄습니다: ${p}`);
    const buffer = readRange(target, real, { offset, length });
    if (buffer.length < length) throw new FcError(`MP4 파일을 끝까지 읽지 못했습니다: ${p}`);
    return buffer;
  };
}

// 박스 헤더를 풀어 { type, start, end }를 돌려준다. start는 내용의 시작이다. 틀린 헤더면 null이다.
// size 0은 "파일 끝까지"인데 최상위에서만 뜻이 있다. 안쪽의 0은 옛 QuickTime udta의 끝 표시이므로 null로 돌려 순회를 끝낸다.
function readBoxHeader(read, offset, end, topLevel) {
  if (end - offset < 8) return null;
  const head = read(offset, Math.min(16, end - offset));
  const type = fourcc(head, 4);
  const size32 = head.readUInt32BE(0);
  let size = size32;
  let start = offset + 8;
  if (size32 === 0) {
    if (!topLevel) return null;
    size = end - offset;
  } else if (size32 === 1) {
    if (head.length < 16) return null;
    const large = head.readBigUInt64BE(8);
    if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    size = Number(large);
    start = offset + 16;
  }
  if (size < start - offset || offset + size > end) return null;
  return { type, start, end: offset + size };
}

// start~end 안의 자식 박스를 차례로 돌려준다.
// 끝에 남은 8바이트 미만은 무시한다. 틀린 헤더를 만나면 strict일 때만 오류이고, 아니면 거기서 끝낸다.
function* boxes(read, p, start, end, strict) {
  let offset = start;
  while (end - offset >= 8) {
    const box = readBoxHeader(read, offset, end, false);
    if (!box) {
      // 크기 0은 끝 표시라 손상이 아니다.
      if (strict && read(offset, 4).readUInt32BE(0) !== 0) throw new FcError(`MP4 구조가 손상됐습니다: ${p} (${offset}바이트 위치)`);
      return;
    }
    yield box;
    offset = box.end;
  }
}

// 최상위 박스를 훑어 moov를 찾는다. mdat은 내용을 읽지 않고 건너뛴다.
function findMoov(read, p, size) {
  let offset = 0;
  let first = true;
  while (size - offset >= 8) {
    const box = readBoxHeader(read, offset, size, true);
    const type = box ? box.type : fourcc(read(offset, 8), 4);
    if (first && !FIRST_BOXES.has(type)) break;
    first = false;
    if (!box) {
      if (type === 'moov') throw new FcError(`MP4 파일의 moov 박스가 잘렸습니다: ${p}`);
      throw new FcError(`MP4 파일에 moov 박스가 없습니다. 파일이 잘렸을 수 있습니다: ${p}`);
    }
    if (type === 'moov') return box;
    offset = box.end;
  }
  if (first) throw new FcError(`MP4/MOV 형식이 아닙니다: ${p}`);
  throw new FcError(`MP4 파일에 moov 박스가 없습니다. 파일이 잘렸을 수 있습니다: ${p}`);
}

// 값이 박스 안에 다 들어 있으면 그 값을, 아니면 null을 돌려준다.
function readPayload(read, box, length) {
  const available = box.end - box.start;
  if (available < length) return null;
  return read(box.start, length);
}

// 버전·플래그의 첫 바이트를 돌려준다. 0, 1이 아닌 버전은 구조를 알 수 없으므로 null이다.
function readVersion(read, box) {
  const head = readPayload(read, box, 1);
  return head && head[0] <= 1 ? head[0] : null;
}

// 재생 시간이 정해지지 않았으면 값이 전부 1로 채워져 있으므로 null로 본다.
function durationValue(buffer, offset, version) {
  if (version === 1) {
    const value = buffer.readBigUInt64BE(offset);
    return value === 0xffffffffffffffffn || value > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(value);
  }
  const value = buffer.readUInt32BE(offset);
  return value === 0xffffffff ? null : value;
}

function readMvhd(read, box) {
  const version = readVersion(read, box);
  if (version === null) return null;
  const body = readPayload(read, box, version === 1 ? 32 : 20);
  if (!body) return null;
  return version === 1
    ? { timescale: body.readUInt32BE(20), duration: durationValue(body, 24, 1) }
    : { timescale: body.readUInt32BE(12), duration: durationValue(body, 16, 0) };
}

function readMehd(read, box) {
  const version = readVersion(read, box);
  if (version === null) return null;
  const body = readPayload(read, box, version === 1 ? 12 : 8);
  return body ? durationValue(body, 4, version) : null;
}

// 16.16 고정소수점의 정수 부분이 화면에 보이는 크기다.
function readTkhd(read, box) {
  const version = readVersion(read, box);
  if (version === null) return null;
  const body = readPayload(read, box, version === 1 ? 96 : 84);
  if (!body) return null;
  const at = version === 1 ? 88 : 76;
  return {
    enabled: (body.readUInt8(3) & 1) === 1,
    duration: durationValue(body, version === 1 ? 28 : 20, version) ?? 0,
    width: body.readUInt32BE(at) >>> 16,
    height: body.readUInt32BE(at + 4) >>> 16,
  };
}

// 첫 표본 항목의 인코딩 해상도를 읽는다. 항목 앞에 4+4바이트, 항목 안 32바이트 위치에 너비와 높이가 있다.
function readStsd(read, box) {
  const body = readPayload(read, box, 44);
  if (!body || body.readUInt32BE(4) === 0) return null;
  return { width: body.readUInt16BE(40), height: body.readUInt16BE(42) };
}

function readTrack(read, p, trak) {
  let header = null;
  let handler = null;
  let sample = null;
  for (const box of boxes(read, p, trak.start, trak.end, true)) {
    if (box.type === 'tkhd') header = readTkhd(read, box);
    if (box.type !== 'mdia') continue;
    for (const part of boxes(read, p, box.start, box.end, true)) {
      if (part.type === 'hdlr') {
        const body = readPayload(read, part, 12);
        if (body) handler = fourcc(body, 8);
      }
      if (part.type !== 'minf') continue;
      for (const inner of boxes(read, p, part.start, part.end, true)) {
        if (inner.type !== 'stbl') continue;
        for (const table of boxes(read, p, inner.start, inner.end, true)) {
          if (table.type === 'stsd') sample = readStsd(read, table);
        }
      }
    }
  }
  if (handler !== 'vide') return null;
  // 인코딩 해상도(stsd)를 먼저 쓰고, 0이면 화면 크기(tkhd)를 쓴다.
  const width = sample?.width || header?.width || 0;
  const height = sample?.height || header?.height || 0;
  if (width === 0 || height === 0) return null;
  return { width, height, enabled: header?.enabled ?? true, duration: header?.duration ?? 0 };
}

// 표지 그림이나 미리보기 트랙이 본편보다 클 수 있으므로, 켜진 트랙 중 재생 시간이 긴 트랙을 고르고 같으면 큰 쪽을 고른다.
function mainVideo(tracks) {
  return tracks.reduce((best, track) => {
    if (!best) return track;
    const order = Number(track.enabled) - Number(best.enabled) || track.duration - best.duration || track.width * track.height - best.width * best.height;
    return order > 0 ? track : best;
  }, null);
}

// UTF-16은 BOM이 있으면 따르고, 없으면 big endian으로 읽는다. 잘못된 글자는 U+FFFD로 바뀐다.
function decodeText(buffer, encoding = 'utf-8') {
  let text;
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) text = new TextDecoder('utf-16le').decode(buffer);
  else if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) text = new TextDecoder('utf-16be').decode(buffer);
  else text = new TextDecoder(encoding).decode(buffer);
  return text.replace(/\0+[^]*$/, '').trim();
}

function remember(tags, key, text) {
  if (text && !tags.has(key)) tags.set(key, text);
}

// ilst 항목 안의 data 박스를 읽는다. 앞 8바이트는 형식과 언어다. 형식 0·1은 UTF-8, 2는 UTF-16BE이고 나머지(숫자, 그림 등)는 글자가 아니다.
function readDataBox(read, p, item) {
  for (const box of boxes(read, p, item.start, item.end, false)) {
    if (box.type !== 'data') continue;
    const length = box.end - box.start;
    if (length <= 8 || length > MAX_TEXT) continue;
    const body = read(box.start, length);
    const kind = body.readUInt32BE(0);
    if (kind > 2) continue;
    const text = decodeText(body.subarray(8), kind === 2 ? 'utf-16be' : 'utf-8');
    if (text) return text;
  }
  return null;
}

// keys 박스의 값은 ilst 항목의 번호(1부터)와 짝이 된다.
function readKeys(read, box) {
  const length = box.end - box.start;
  if (length < 8 || length > MAX_TEXT) return [];
  const body = read(box.start, length);
  const names = [];
  let offset = 8;
  for (let i = 0; i < body.readUInt32BE(4) && body.length - offset >= 8; i += 1) {
    const size = body.readUInt32BE(offset);
    if (size < 8 || size > body.length - offset) break;
    names.push(body.toString('utf8', offset + 8, offset + size));
    offset += size;
  }
  return names;
}

// meta는 ISO 형식이면 앞에 0으로 찬 4바이트(버전·플래그)가 있고, QuickTime 형식이면 그 자리가 첫 자식의 크기라 0이 아니다.
function readMeta(read, p, meta, tags) {
  const head = readPayload(read, meta, 4);
  if (!head) return;
  const start = head.readUInt32BE(0) === 0 ? meta.start + 4 : meta.start;
  let names = null;
  const items = [];
  for (const box of boxes(read, p, start, meta.end, false)) {
    if (box.type === 'keys') names = readKeys(read, box);
    if (box.type === 'ilst') items.push(...boxes(read, p, box.start, box.end, false));
  }
  for (const item of items) {
    const index = Buffer.from(item.type, 'latin1').readUInt32BE(0);
    // keys가 있으면 항목 이름은 글자가 아니라 번호다.
    const key = names ? names[index - 1] && `mdta:${names[index - 1]}` : `ilst:${item.type}`;
    if (key && (TITLE_SOURCES.includes(key) || COMMENT_SOURCES.includes(key))) remember(tags, key, readDataBox(read, p, item));
  }
}

// 옛 QuickTime 항목은 길이 2바이트, 언어 2바이트, 글자 순으로 여러 언어가 이어진다. 첫 값을 쓴다.
function readClassicText(read, box) {
  const length = box.end - box.start;
  if (length < 4 || length > MAX_TEXT) return null;
  const body = read(box.start, length);
  const size = body.readUInt16BE(0);
  if (size === 0 || size > length - 4) return null;
  return decodeText(body.subarray(4, 4 + size));
}

// 3GPP 항목은 버전·플래그 4바이트, 언어 2바이트, 글자 순이다.
function readGppText(read, box) {
  const length = box.end - box.start;
  if (length <= 6 || length > MAX_TEXT) return null;
  return decodeText(read(box.start, length).subarray(6));
}

function readUdta(read, p, udta, tags) {
  for (const box of boxes(read, p, udta.start, udta.end, false)) {
    if (box.type === 'meta') readMeta(read, p, box, tags);
    if (box.type === '©nam' || box.type === '©cmt') remember(tags, `udta:${box.type}`, readClassicText(read, box));
    if (box.type === 'titl' || box.type === 'dscp') remember(tags, `udta:${box.type}`, readGppText(read, box));
  }
}

function firstTag(tags, sources) {
  for (const source of sources) {
    if (tags.has(source)) return tags.get(source);
  }
  return null;
}

// 타겟 안 MP4/MOV 파일의 메타데이터를 읽어 { title, comment, duration, width, height, bitrate }를 돌려준다.
// 찾지 못한 값은 null이다. duration은 초, bitrate는 파일 전체 크기로 계산한 초당 비트다.
// 필요한 박스만 나눠 읽으므로 파일이 커도 내용 전체를 메모리에 올리지 않는다.
// 경로나 입출력 문제, MP4/MOV가 아닌 파일, moov 앞이나 moov 자신이 잘린 파일, 읽은 구조의 손상은 FcError를 낸다.
// 깨진 파일 판별기는 아니다. moov 뒤의 mdat이 잘렸거나 0으로 채워진 파일은 잡지 못하고, 제목·코멘트(udta, meta) 쪽 손상은 찾은 값까지만 돌려준다.
function readMp4Metadata(dir, p) {
  const access = grant(dir, ['read']);
  const real = access.read(p);
  try {
    return parseMp4(access.target, real, p);
  } catch (err) {
    if (err.syscall) throw new FcError(`MP4 파일을 읽을 수 없습니다: ${p} (${err.code})`);
    throw err;
  }
}

function parseMp4(target, real, p) {
  const size = fileSizeInside(target, real);
  const read = makeReader(target, real, p);
  const moov = findMoov(read, p, size);

  let movie = null;
  let fragmentDuration = null;
  const tracks = [];
  const tags = new Map();
  for (const box of boxes(read, p, moov.start, moov.end, true)) {
    if (box.type === 'mvhd') movie = readMvhd(read, box);
    if (box.type === 'trak') {
      const track = readTrack(read, p, box);
      if (track) tracks.push(track);
    }
    if (box.type === 'mvex') {
      for (const part of boxes(read, p, box.start, box.end, true)) {
        if (part.type === 'mehd') fragmentDuration = readMehd(read, part);
      }
    }
    if (box.type === 'udta') readUdta(read, p, box, tags);
    if (box.type === 'meta') readMeta(read, p, box, tags);
  }

  // mehd는 조각까지 합한 전체 길이이고 mvhd는 moov 안 부분의 길이이므로 mehd를 먼저 쓴다.
  const units = fragmentDuration || movie?.duration;
  const duration = units && movie?.timescale ? units / movie.timescale : null;
  const video = mainVideo(tracks);
  return {
    title: firstTag(tags, TITLE_SOURCES),
    comment: firstTag(tags, COMMENT_SOURCES),
    duration,
    width: video?.width ?? null,
    height: video?.height ?? null,
    bitrate: duration ? Math.round((size * 8) / duration) : null,
  };
}

module.exports = { readMp4Metadata };

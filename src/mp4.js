'use strict';

const { FcError } = require('./commands');
const { grant, readRange, fileSizeInside } = require('./target');
const { spsAspect } = require('./videoSps');

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

// 변환 행렬 { a b u / c d v / x y w }에서 a와 d가 0이고 b와 c가 0이 아니면 90도나 270도 회전이다(휴대폰 세로 영상).
// 0·180도와 그 밖의 행렬(기울임 등)은 너비와 높이를 바꾸지 않는 것으로 본다.
function isQuarterTurn(body, offset) {
  const [a, b, c, d] = [0, 4, 12, 16].map((at) => body.readInt32BE(offset + at));
  return a === 0 && d === 0 && b !== 0 && c !== 0;
}

// quarterTurn은 영상 전체에 걸리는 mvhd 행렬의 회전이다. 행렬까지 들어 있지 않으면 거짓이다(#113).
function readMvhd(read, box) {
  const version = readVersion(read, box);
  if (version === null) return null;
  const body = readPayload(read, box, version === 1 ? 32 : 20);
  if (!body) return null;
  const matrix = readPayload(read, box, version === 1 ? 84 : 72);
  const quarterTurn = matrix ? isQuarterTurn(matrix, version === 1 ? 48 : 36) : false;
  return version === 1
    ? { timescale: body.readUInt32BE(20), duration: durationValue(body, 24, 1), quarterTurn }
    : { timescale: body.readUInt32BE(12), duration: durationValue(body, 16, 0), quarterTurn };
}

function readMehd(read, box) {
  const version = readVersion(read, box);
  if (version === null) return null;
  const body = readPayload(read, box, version === 1 ? 12 : 8);
  return body ? durationValue(body, 4, version) : null;
}

// 화면 크기(트랙 행렬을 걸기 전)는 16.16 고정소수점이다. width, height는 정수 부분이고 exactWidth, exactHeight는 소수까지 담는다.
// 트랙 행렬이 90도나 270도 회전이면 quarterTurn이 참이다.
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
    exactWidth: body.readUInt32BE(at) / 65536,
    exactHeight: body.readUInt32BE(at + 4) / 65536,
    quarterTurn: isQuarterTurn(body, version === 1 ? 52 : 40),
  };
}

// 영상 표본 항목의 고정 필드 길이. 그 뒤에 avcC, pasp 같은 자식 박스가 온다.
const VISUAL_ENTRY = 78;

// avcC·hvcC는 SPS와 PPS 몇 개라 보통 수백 바이트다. 더 크면 읽지 않는다.
const MAX_CODEC_CONFIG = 64 * 1024;

// 첫 표본 항목의 인코딩 해상도와 화소 비율을 읽는다. 항목 앞에 4+4바이트, 항목 안 32바이트 위치에 너비와 높이가 있다.
// pasp는 { h, v }로 화소 하나의 가로:세로 비율이다. 없거나 0이 든 값이면 null이다. 1:1도 값으로 둔다.
// spsAspect는 avcC·hvcC 안 SPS의 화소 비율이다(#113). 영상 데이터(mdat)는 읽지 않는다.
function readStsd(read, p, box) {
  const body = readPayload(read, box, 44);
  if (!body || body.readUInt32BE(4) === 0) return null;
  const sample = { width: body.readUInt16BE(40), height: body.readUInt16BE(42), pasp: null, spsAspect: null };
  const entry = readBoxHeader(read, box.start + 8, box.end, false);
  if (!entry || entry.end - entry.start <= VISUAL_ENTRY) return sample;
  for (const child of boxes(read, p, entry.start + VISUAL_ENTRY, entry.end, false)) {
    if (child.type === 'pasp' && sample.pasp === null) {
      const spacing = readPayload(read, child, 8);
      if (spacing && spacing.readUInt32BE(0) > 0 && spacing.readUInt32BE(4) > 0) sample.pasp = { h: spacing.readUInt32BE(0), v: spacing.readUInt32BE(4) };
    }
    if ((child.type === 'avcC' || child.type === 'hvcC') && sample.spsAspect === null && child.end - child.start <= MAX_CODEC_CONFIG) {
      sample.spsAspect = spsAspect(child.type, read(child.start, child.end - child.start));
    }
  }
  return sample;
}

// 화소 비율을 곱한 너비 (정사각형 화소면 그대로)
const stretched = (width, aspect) => (Math.abs(aspect - 1) > 1e-9 ? Math.max(1, Math.round(width * aspect)) : width);

// 회전을 걸기 전의 보이는 크기. 화소 비율은 컨테이너 값을 영상 데이터 값보다 먼저 쓴다(FFmpeg가 pasp를 SPS보다 먼저 쓰는 것과 같다).
// 1. pasp: 화소 비율을 직접 적은 값이다. 1:1이면 정사각형 화소로 본다.
// 2. tkhd 화면 크기가 인코딩 해상도와 다르면 그 크기. 규격상 표본 그림은 이 크기로 늘여 보여 준다. pasp 없이 tkhd에만 화소 비율을 반영한 파일이 있다.
//    너비와 높이를 같은 배율로 바꾼 크기는 화소 비율 1로 보고 인코딩 해상도를 쓴다.
//    회전하는 영상인데 tkhd에 회전한 뒤의 크기를 적은 파일(너비와 높이가 바뀐 비율)은 화소 비율이 아니라서 쓰지 않는다.
// 3. SPS의 화소 비율(VUI). pasp도 없고 tkhd도 인코딩 해상도와 같을 때 쓴다(ffmpeg로 만든 일부 파일).
function unrotatedSize(sample, header, turned) {
  const { width, height } = sample;
  if (sample.pasp) return [stretched(width, sample.pasp.h / sample.pasp.v), height];
  if (header && header.exactWidth > 0 && header.exactHeight > 0 && (header.width !== sample.width || header.height !== sample.height)) {
    const aspect = (header.exactWidth * height) / (header.exactHeight * width);
    const swapped = (header.exactWidth * width) / (header.exactHeight * height);
    if (turned && Math.abs(swapped - 1) < 0.01) return [width, height];
    if (Math.abs(aspect - 1) < 1e-9) return [width, height];
    return [Math.max(1, Math.round(header.exactWidth)), Math.max(1, Math.round(header.exactHeight))];
  }
  if (sample.spsAspect) return [stretched(width, sample.spsAspect.h / sample.spsAspect.v), height];
  return [width, height];
}

// movieTurn은 mvhd 행렬의 회전이다. 트랙 행렬과 함께 걸리므로 둘 중 하나만 90·270도이면 너비와 높이가 바뀐다.
function readTrack(read, p, trak, movieTurn) {
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
          if (table.type === 'stsd') sample = readStsd(read, p, table);
        }
      }
    }
  }
  if (handler !== 'vide') return null;
  // 인코딩 해상도(stsd)를 먼저 쓰고, 0이면 화면 크기(tkhd)를 쓴다.
  const width = sample?.width || header?.width || 0;
  const height = sample?.height || header?.height || 0;
  if (width === 0 || height === 0) return null;
  // 보이는 크기. 화소 비율을 반영하고(unrotatedSize), 90·270도 회전이면 너비와 높이를 바꾼다.
  // 인코딩 해상도가 0이라 tkhd 크기를 쓴 경우는 이미 보이는 크기라 화소 비율을 다시 곱하지 않는다.
  const turned = Boolean(header?.quarterTurn) !== Boolean(movieTurn);
  const [shownWidth, shownHeight] = sample?.width && sample?.height ? unrotatedSize(sample, header, turned) : [width, height];
  const [displayWidth, displayHeight] = turned ? [shownHeight, shownWidth] : [shownWidth, shownHeight];
  return { width, height, displayWidth, displayHeight, enabled: header?.enabled ?? true, duration: header?.duration ?? 0 };
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

// 타겟 안 MP4/MOV 파일의 메타데이터를 읽어 { title, comment, duration, width, height, displayWidth, displayHeight, bitrate }를 돌려준다.
// 찾지 못한 값은 null이다. duration은 초, bitrate는 파일 전체 크기로 계산한 초당 비트다.
// width, height는 인코딩 해상도이고, displayWidth, displayHeight는 화소 비율과 90·270도 회전을 반영한 보이는 크기다(#106, #113).
// 화소 비율은 pasp, tkhd 화면 크기, SPS 순으로 고르고(pixelAspect), 회전은 트랙(tkhd)과 영상 전체(mvhd) 행렬을 함께 본다.
// 필요한 박스만 나눠 읽으므로 파일이 커도 내용 전체를 메모리에 올리지 않는다.
// 경로나 입출력 문제, MP4/MOV가 아닌 파일, moov 앞이나 moov 자신이 잘린 파일, 읽은 구조의 손상은 FcError를 낸다.
// 깨진 파일 판별은 checkMp4Structure가 한다. 이 함수는 moov 뒤의 mdat이 잘렸거나 0으로 채워진 파일은 잡지 못하고, 제목·코멘트(udta, meta) 쪽 손상은 찾은 값까지만 돌려준다.
function readMp4Metadata(dir, p) {
  try {
    const access = grant(dir, ['read']);
    return parseMp4(access.target, access.read(p), p);
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
  const traks = [];
  const tags = new Map();
  for (const box of boxes(read, p, moov.start, moov.end, true)) {
    if (box.type === 'mvhd') movie = readMvhd(read, box);
    // mvhd의 회전을 함께 반영해야 하므로 트랙은 moov를 다 훑은 뒤에 읽는다. mvhd가 트랙 뒤에 오는 파일도 있다.
    if (box.type === 'trak') traks.push(box);
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
  const tracks = traks.map((box) => readTrack(read, p, box, movie?.quarterTurn)).filter(Boolean);
  const video = mainVideo(tracks);
  return {
    title: firstTag(tags, TITLE_SOURCES),
    comment: firstTag(tags, COMMENT_SOURCES),
    duration,
    width: video?.width ?? null,
    height: video?.height ?? null,
    displayWidth: video?.displayWidth ?? null,
    displayHeight: video?.displayHeight ?? null,
    bitrate: duration ? Math.round((size * 8) / duration) : null,
  };
}

// start~end의 자식 박스를 모아 { list, complete }로 돌려준다. complete가 false면 중간에 틀린 헤더를 만났다. 크기 0은 끝 표시라 틀린 것이 아니다.
function childBoxes(read, start, end) {
  const list = [];
  let offset = start;
  while (end - offset >= 8) {
    const box = readBoxHeader(read, offset, end, false);
    if (!box) return { list, complete: read(offset, 4).readUInt32BE(0) === 0 };
    list.push(box);
    offset = box.end;
  }
  return { list, complete: true };
}

// 데이터가 다른 파일에 있는 트랙인지 본다. dref 항목의 플래그 끝 비트가 1이면 이 파일 안이다. 위치 문자열이 없으면 가리킬 파일이 없으므로 이 파일로 본다.
function isExternalTrack(read, minf) {
  const dinf = findChild(read, minf, 'dinf');
  const dref = dinf && findChild(read, dinf, 'dref');
  if (!dref || dref.end - dref.start < 8) return false;
  return childBoxes(read, dref.start + 8, dref.end).list.some((entry) => entry.end - entry.start > 4 && (read(entry.start, 4).readUInt32BE(0) & 1) === 0);
}

function findChild(read, parent, type) {
  return childBoxes(read, parent.start, parent.end).list.find((box) => box.type === type);
}

// 트랙의 데이터 위치표(stco, co64)를 본다. 문제가 없으면 null을, 있으면 { outside, reason }을 돌려준다.
// outside는 위치표가 파일 끝 너머를 가리키는 경우다. 이 파일에 데이터가 없다는 뜻이므로 다른 트랙과 상관없이 손상이다.
function checkTrack(read, trak, size) {
  const unsound = (reason) => ({ outside: false, reason });
  const mdia = findChild(read, trak, 'mdia');
  const minf = mdia && findChild(read, mdia, 'minf');
  const stbl = minf && findChild(read, minf, 'stbl');
  if (!stbl) return unsound('트랙에 mdia, minf, stbl 박스가 온전하지 않습니다.');
  if (isExternalTrack(read, minf)) return null;
  const table = childBoxes(read, stbl.start, stbl.end).list.find((box) => box.type === 'stco' || box.type === 'co64');
  if (!table) return unsound('트랙에 데이터 위치표(stco, co64)가 없습니다.');
  if (table.end - table.start < 8) return unsound('데이터 위치표가 잘렸습니다.');
  const count = read(table.start + 4, 4).readUInt32BE(0);
  if (count === 0) return null;
  const width = table.type === 'co64' ? 8 : 4;
  if (8 + count * width > table.end - table.start) return unsound('데이터 위치표가 잘렸습니다.');
  const at = read(table.start + 8 + (count - 1) * width, width);
  const last = width === 8 ? at.readBigUInt64BE(0) : BigInt(at.readUInt32BE(0));
  return last >= BigInt(size) ? { outside: true, reason: '데이터 위치표가 파일 끝 너머를 가리킵니다. 잘린 파일일 수 있습니다.' } : null;
}

// 넘어도 잘렸다고 볼 수 있는 박스. 다른 이름은 뒤에 덧붙은 데이터일 수 있다.
const CONTENT_BOXES = new Set(['moov', 'mdat', 'moof']);

// MP4/MOV의 구조가 온전한지 본다. 손상이면 { status: 'broken', reason }을, 의심스러우면 { status: 'suspect', reason }을, 문제를 찾지 못하면 null을 돌려준다.
// 입출력 문제와 읽기 한도 초과는 예외로 나간다.
// 최상위 박스, moov 안의 mvhd와 trak, 트랙의 데이터 위치표까지 본다. 영상 데이터 자체는 읽지 않으므로 mdat 안의 손상은 찾지 못한다.
// 재생에 필요한 구조가 온전하면 그 뒤의 패딩이나 덧붙은 데이터는 손상으로 보지 않는다. 압축된 moov(cmov)와 참조 무비(rmra)는 판단하지 않는다.
function checkMp4Structure(target, real, p) {
  const broken = (reason) => ({ status: 'broken', reason });
  const size = fileSizeInside(target, real);
  const read = makeReader(target, real, p);
  let moov = null;
  let fragment = false;
  let trailing = false;
  let offset = 0;
  while (size - offset >= 8) {
    const box = readBoxHeader(read, offset, size, true);
    const type = box ? box.type : fourcc(read(offset, 8), 4);
    if (!box && CONTENT_BOXES.has(type)) return broken(`${type} 박스가 파일 끝을 넘습니다. 잘린 파일일 수 있습니다.`);
    if (!box || /[\x00-\x1f]/.test(type)) {
      trailing = true;
      break;
    }
    if (type === 'moov' && !moov) moov = box;
    if (type === 'moof' || (type === 'styp' && offset === 0)) fragment = true;
    offset = box.end;
  }
  // DASH, HLS의 미디어 조각은 moov 없이 moof만 있다. 초기화 파일이 따로 있으므로 이 파일만으로는 판단할 수 없다.
  if (!moov && fragment) return { status: 'suspect', reason: 'moov 없이 조각(moof)만 있는 파일입니다. 스트리밍 조각일 수 있습니다.' };
  if (!moov) return broken('moov 박스가 없습니다. 끝까지 받지 못했거나 내용이 손상된 파일일 수 있습니다.');
  const { list, complete } = childBoxes(read, moov.start, moov.end);
  if (list.some((box) => box.type === 'cmov' || box.type === 'rmra')) return null;
  if (!list.some((box) => box.type === 'mvhd')) return broken('moov 박스에 mvhd가 없습니다.');
  const tracks = list.filter((box) => box.type === 'trak');
  if (tracks.length === 0) {
    if (list.some((box) => box.type === 'mvex')) return { status: 'suspect', reason: 'moov 박스에 트랙이 없습니다.' };
    return broken('moov 박스에 트랙이 없습니다.');
  }
  const problems = tracks.map((trak) => checkTrack(read, trak, size)).filter((problem) => problem !== null);
  const outside = problems.find((problem) => problem.outside);
  if (outside) return broken(outside.reason);
  if (problems.length === tracks.length) return broken(problems[0].reason);
  if (problems.length > 0) return { status: 'suspect', reason: problems[0].reason };
  if (!complete) return { status: 'suspect', reason: 'moov 박스 끝에 박스가 아닌 데이터가 있습니다. 트랙은 온전합니다.' };
  return trailing ? { status: 'suspect', reason: `${offset}바이트 위치부터 뒤에 박스가 아닌 데이터가 있습니다. 구조는 온전합니다.` } : null;
}

module.exports = { readMp4Metadata, checkMp4Structure, FIRST_BOXES };

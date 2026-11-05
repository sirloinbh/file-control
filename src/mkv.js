'use strict';

const { FcError } = require('./commands');
const { grant, readRange, fileSizeInside } = require('./target');

const ID = {
  EBML: 0x1a45dfa3,
  DOC_TYPE: 0x4282,
  SEGMENT: 0x18538067,
  SEEK_HEAD: 0x114d9b74,
  SEEK: 0x4dbb,
  SEEK_ID: 0x53ab,
  SEEK_POSITION: 0x53ac,
  INFO: 0x1549a966,
  TIMECODE_SCALE: 0x2ad7b1,
  DURATION: 0x4489,
  TITLE: 0x7ba9,
  TRACKS: 0x1654ae6b,
  TRACK_ENTRY: 0xae,
  TRACK_TYPE: 0x83,
  VIDEO: 0xe0,
  PIXEL_WIDTH: 0xb0,
  PIXEL_HEIGHT: 0xba,
  DISPLAY_WIDTH: 0x54b0,
  DISPLAY_HEIGHT: 0x54ba,
  DISPLAY_UNIT: 0x54b2,
  PIXEL_CROP_BOTTOM: 0x54aa,
  PIXEL_CROP_TOP: 0x54bb,
  PIXEL_CROP_LEFT: 0x54cc,
  PIXEL_CROP_RIGHT: 0x54dd,
  PROJECTION: 0x7670,
  PROJECTION_TYPE: 0x7671,
  PROJECTION_POSE_YAW: 0x7673,
  PROJECTION_POSE_PITCH: 0x7674,
  PROJECTION_POSE_ROLL: 0x7675,
  TAGS: 0x1254c367,
  TAG: 0x7373,
  TARGETS: 0x63c0,
  TARGET_TYPE_VALUE: 0x68ca,
  TAG_TRACK_UID: 0x63c5,
  TAG_EDITION_UID: 0x63c9,
  TAG_CHAPTER_UID: 0x63c4,
  TAG_ATTACHMENT_UID: 0x63c6,
  SIMPLE_TAG: 0x67c8,
  TAG_NAME: 0x45a3,
  TAG_STRING: 0x4487,
  CLUSTER: 0x1f43b675,
};

const WANTED = new Set([ID.SEEK_HEAD, ID.INFO, ID.TRACKS, ID.TAGS]);
// 어디에나 올 수 있는 요소 (Void, CRC-32)
const GLOBAL_ELEMENTS = new Set([0xec, 0xbf]);
// 머리 요소를 찾는 데 필요한 읽기 횟수 한도. 손상된 파일이 작은 요소를 끝없이 늘어놓아도 멈춘다.
const MAX_READS = 20000;
// 한 요소를 메모리에 올리는 한도. 더 크면 없는 것으로 본다. 정상 파일의 Info, Tracks, Tags는 이보다 훨씬 작다.
const MAX_ELEMENT = 16 * 1024 * 1024;
// 파일 하나에서 읽는 총량 한도. 겹치게 만든 SeekHead가 같은 내용을 되풀이해 읽게 해도 메모리가 고갈되지 않는다.
const MAX_TOTAL = 64 * 1024 * 1024;
// SeekHead에서 받는 항목 수 한도. 정상 파일은 열 개 안팎이다.
const MAX_SEEK = 1024;
const MAX_TEXT = 64 * 1024;
const MAX_HEADER = 12;
const DEFAULT_SCALE = 1000000;
const VIDEO_TRACK = 1;
// 영화나 에피소드 수준. 값이 없으면 이 수준이다. 70은 묶음, 30은 곡이나 챕터라 파일의 제목이 아니다.
const MOVIE_LEVEL = 50;

// 앞 바이트의 첫 1 비트 위치가 길이를 정한다. 틀리면 null이다.
function vintLength(first, max) {
  for (let length = 1; length <= max; length += 1) {
    if (first & (0x80 >> (length - 1))) return length;
  }
  return null;
}

// 요소 머리글을 풀어 { id, start, size }를 돌려준다. size가 null이면 크기를 모르는 요소다. 틀리면 null이다.
function readHeader(buffer, offset) {
  if (offset >= buffer.length) return null;
  const idLength = vintLength(buffer[offset], 4);
  if (idLength === null || offset + idLength >= buffer.length) return null;
  const id = buffer.readUIntBE(offset, idLength);
  const sizeOffset = offset + idLength;
  const sizeLength = vintLength(buffer[sizeOffset], 8);
  if (sizeLength === null || sizeOffset + sizeLength > buffer.length) return null;
  let value = BigInt(buffer[sizeOffset] & (0xff >> sizeLength));
  let unknown = value === BigInt(0xff >> sizeLength);
  for (let index = 1; index < sizeLength; index += 1) {
    value = (value << 8n) | BigInt(buffer[sizeOffset + index]);
    if (buffer[sizeOffset + index] !== 0xff) unknown = false;
  }
  if (!unknown && value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return { id, start: sizeOffset + sizeLength, size: unknown ? null : Number(value) };
}

// 메모리에 올린 요소의 자식을 차례로 내놓는다. 구조가 어긋나면 거기서 멈춘다. 찾은 값까지는 쓸 수 있다.
function* children(buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const header = readHeader(buffer, offset);
    if (!header || header.size === null || header.start + header.size > buffer.length) return;
    yield { id: header.id, body: buffer.subarray(header.start, header.start + header.size) };
    offset = header.start + header.size;
  }
}

function readUint(body) {
  if (body.length === 0 || body.length > 8) return null;
  let value = 0n;
  for (const byte of body) value = (value << 8n) | BigInt(byte);
  return value > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(value);
}

function readFloat(body) {
  let value = null;
  if (body.length === 4) value = body.readFloatBE(0);
  if (body.length === 8) value = body.readDoubleBE(0);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function readText(body) {
  if (body.length === 0 || body.length > MAX_TEXT) return null;
  const end = body.indexOf(0);
  const text = body.toString('utf8', 0, end === -1 ? body.length : end).trim();
  return text === '' ? null : text;
}

function parseInfo(body, found) {
  let scale = DEFAULT_SCALE;
  let ticks = null;
  for (const child of children(body)) {
    // 빈 요소는 기본값으로 읽는다. 0은 규격 위반이라 없는 값으로 본다.
    if (child.id === ID.TIMECODE_SCALE) scale = child.body.length === 0 ? DEFAULT_SCALE : readUint(child.body) || null;
    if (child.id === ID.DURATION) ticks = readFloat(child.body);
    if (child.id === ID.TITLE) found.title ??= readText(child.body);
  }
  const seconds = ticks !== null && scale !== null ? (ticks * scale) / 1e9 : null;
  if (Number.isFinite(seconds) && seconds > 0) found.duration ??= seconds;
}

// 부호 있는 실수. 빈 요소는 기본값 0이다. 읽을 수 없으면 null이다.
function readSignedFloat(body) {
  if (body.length === 0) return 0;
  let value = null;
  if (body.length === 4) value = body.readFloatBE(0);
  if (body.length === 8) value = body.readDoubleBE(0);
  return Number.isFinite(value) ? value : null;
}

// 보이는 크기. 잘라 낼 화소(PixelCrop)를 먼저 뺀다. DisplayWidth와 DisplayHeight는 자른 뒤의 크기이고, 없으면 자른 크기와 같다(규격의 기본값, #113).
// 단위(DisplayUnit)가 화소(0)면 그 값을 쓰고, cm(1)·인치(2)·화면 비율(3)이면 비율만 뜻이 있어 높이를 자른 높이에 맞춘다.
// 단위를 모르면(4 등) 자른 크기를 쓴다. 화소 단위에서 한쪽만 있으면 다른 쪽은 자른 크기를 쓴다(규격의 기본값).
// 화소가 아닌 단위는 기본값이 없으므로 한쪽만 있으면 비율을 알 수 없어 자른 크기를 쓴다.
// 자르고 남는 화소가 없으면 틀린 값이라 자르지 않는다.
function displaySize(width, height, shownWidth, shownHeight, unit, crop) {
  const croppedWidth = width - crop.left - crop.right;
  const croppedHeight = height - crop.top - crop.bottom;
  const [baseWidth, baseHeight] = croppedWidth > 0 && croppedHeight > 0 ? [croppedWidth, croppedHeight] : [width, height];
  if (unit === null || unit > 3 || (!shownWidth && !shownHeight)) return [baseWidth, baseHeight];
  if (unit !== 0 && (!shownWidth || !shownHeight)) return [baseWidth, baseHeight];
  const [w, h] = [shownWidth || baseWidth, shownHeight || baseHeight];
  if (unit === 0) return [w, h];
  return [Math.max(1, Math.round((baseHeight * w) / h)), baseHeight];
}

// Projection의 회전이 90·270도이면 참이다(#113). FFmpeg는 회전 정보를 평면(ProjectionType 0) 투영의 ProjectionPoseRoll로 적는다.
// 360도 영상(평면이 아닌 투영)이나 위아래로 기운(Pitch) 투영, 좌우를 180도가 아닌 각으로 돌린(Yaw) 투영은 화면 회전이 아니므로 보지 않는다.
// Roll은 1도 안쪽으로 90의 배수에 가까울 때만 쓴다. 그 밖의 각도는 너비와 높이를 바꾸지 않는 것으로 본다.
function projectionQuarterTurn(body) {
  let type = 0;
  let yaw = 0;
  let pitch = 0;
  let roll = 0;
  for (const child of children(body)) {
    if (child.id === ID.PROJECTION_TYPE) type = child.body.length === 0 ? 0 : readUint(child.body);
    if (child.id === ID.PROJECTION_POSE_YAW) yaw = readSignedFloat(child.body);
    if (child.id === ID.PROJECTION_POSE_PITCH) pitch = readSignedFloat(child.body);
    if (child.id === ID.PROJECTION_POSE_ROLL) roll = readSignedFloat(child.body);
  }
  if (type !== 0 || yaw === null || pitch === null || roll === null) return false;
  if (pitch !== 0 || (yaw !== 0 && Math.abs(yaw) !== 180)) return false;
  const turns = roll / 90;
  return Math.abs(turns - Math.round(turns)) * 90 < 1 && Math.abs(Math.round(turns)) % 2 === 1;
}

function parseTracks(body, found) {
  for (const track of children(body)) {
    if (track.id !== ID.TRACK_ENTRY) continue;
    let type = null;
    let video = null;
    for (const child of children(track.body)) {
      if (child.id === ID.TRACK_TYPE) type = readUint(child.body);
      if (child.id === ID.VIDEO) video = child.body;
    }
    if (type !== VIDEO_TRACK || !video) continue;
    let width = null;
    let height = null;
    let shownWidth = null;
    let shownHeight = null;
    let unit = 0;
    const crop = { top: 0, bottom: 0, left: 0, right: 0 };
    let quarterTurn = false;
    for (const child of children(video)) {
      if (child.id === ID.PIXEL_WIDTH) width = readUint(child.body);
      if (child.id === ID.PIXEL_HEIGHT) height = readUint(child.body);
      if (child.id === ID.DISPLAY_WIDTH) shownWidth = readUint(child.body);
      if (child.id === ID.DISPLAY_HEIGHT) shownHeight = readUint(child.body);
      // 빈 요소는 기본값(0, 화소)이다.
      if (child.id === ID.DISPLAY_UNIT) unit = child.body.length === 0 ? 0 : readUint(child.body);
      // 잘라 낼 화소의 기본값은 0이다. 읽을 수 없는 값도 0으로 본다.
      if (child.id === ID.PIXEL_CROP_TOP) crop.top = readUint(child.body) ?? 0;
      if (child.id === ID.PIXEL_CROP_BOTTOM) crop.bottom = readUint(child.body) ?? 0;
      if (child.id === ID.PIXEL_CROP_LEFT) crop.left = readUint(child.body) ?? 0;
      if (child.id === ID.PIXEL_CROP_RIGHT) crop.right = readUint(child.body) ?? 0;
      if (child.id === ID.PROJECTION) quarterTurn = projectionQuarterTurn(child.body);
    }
    // 표지 같은 작은 영상 트랙이 앞에 있어도 가장 큰 트랙을 본 영상으로 친다.
    if (width && height && width * height > (found.width ?? 0) * (found.height ?? 0)) {
      found.width = width;
      found.height = height;
      const [shownW, shownH] = displaySize(width, height, shownWidth, shownHeight, unit, crop);
      [found.displayWidth, found.displayHeight] = quarterTurn ? [shownH, shownW] : [shownW, shownH];
    }
  }
}

// 특정 트랙이나 챕터에 붙은 태그, 영화 수준이 아닌 태그는 파일의 제목이 아니다.
// UID는 64비트 난수일 수 있어 숫자로 바꾸지 않고 0이 아닌 바이트가 있는지 본다.
function isFileTag(targets) {
  if (!targets) return true;
  for (const child of children(targets)) {
    if ([ID.TAG_TRACK_UID, ID.TAG_EDITION_UID, ID.TAG_CHAPTER_UID, ID.TAG_ATTACHMENT_UID].includes(child.id) && child.body.some((byte) => byte !== 0)) return false;
    if (child.id === ID.TARGET_TYPE_VALUE && child.body.length > 0 && readUint(child.body) !== MOVIE_LEVEL) return false;
  }
  return true;
}

function parseTags(body, tags) {
  for (const tag of children(body)) {
    if (tag.id !== ID.TAG) continue;
    const parts = [...children(tag.body)];
    if (!isFileTag(parts.find((part) => part.id === ID.TARGETS)?.body)) continue;
    for (const simple of parts) {
      if (simple.id !== ID.SIMPLE_TAG) continue;
      let name = null;
      let value = null;
      for (const child of children(simple.body)) {
        if (child.id === ID.TAG_NAME) name = readText(child.body);
        if (child.id === ID.TAG_STRING) value = readText(child.body);
      }
      if (name && value && !tags.has(name.toUpperCase())) tags.set(name.toUpperCase(), value);
    }
  }
}

function parseSeekHead(body, positions) {
  for (const seek of children(body)) {
    if (seek.id !== ID.SEEK) continue;
    let id = null;
    let position = null;
    for (const child of children(seek.body)) {
      if (child.id === ID.SEEK_ID) id = readUint(child.body);
      if (child.id === ID.SEEK_POSITION) position = readUint(child.body);
    }
    if (!WANTED.has(id) || position === null || positions.length >= MAX_SEEK) continue;
    if (!positions.some((item) => item.id === id && item.position === position)) positions.push({ id, position });
  }
}

function makeReader(target, real, p, size) {
  let reads = 0;
  let total = 0;
  return (offset, length) => {
    reads += 1;
    const wanted = Math.min(length, Math.max(0, size - offset));
    total += wanted;
    if (reads > MAX_READS || total > MAX_TOTAL) throw new FcError(`MKV 요소가 너무 많아 읽기를 멈췄습니다: ${p}`);
    return readRange(target, real, { offset, length: wanted });
  };
}

// 파일의 offset에 있는 요소 머리글을 읽는다.
function headerAt(read, offset) {
  const header = readHeader(read(offset, MAX_HEADER), 0);
  return header && { ...header, start: offset + header.start };
}

// 첫 요소가 EBML 머리글이고 문서 형식이 matroska나 webm일 때만 받는다. 머리글의 끝 위치를 돌려준다.
function checkHeader(read, p) {
  const header = headerAt(read, 0);
  if (!header || header.id !== ID.EBML || header.size === null || header.size > MAX_ELEMENT) throw new FcError(`MKV/WebM 형식이 아닙니다: ${p}`);
  const body = read(header.start, header.size);
  const type = [...children(body)].find((child) => child.id === ID.DOC_TYPE);
  const name = type && readText(type.body);
  if (name !== 'matroska' && name !== 'webm') throw new FcError(`MKV/WebM 형식이 아닙니다: ${p}`);
  return header.start + header.size;
}

// 타겟 안 MKV/WebM 파일의 메타데이터를 읽어 { title, comment, duration, width, height, displayWidth, displayHeight, bitrate }를 돌려준다.
// 찾지 못한 값은 null이다. duration은 초, bitrate는 파일 전체 크기로 계산한 초당 비트다.
// width, height는 화소 크기(PixelWidth/Height)이고, displayWidth, displayHeight는 잘라 낼 화소(PixelCrop), DisplayWidth/Height,
// 평면 투영의 90·270도 회전(ProjectionPoseRoll)을 반영한 보이는 크기다(#106, #113). 영상 데이터(CodecPrivate의 SPS) 안의 화소 비율은 보지 않는다. 규격상 DisplayWidth/Height가 없으면 자른 화소 크기가 보이는 크기다.
// 첫 Cluster 앞의 요소를 읽고, 그 뒤에 있는 요소는 SeekHead로 찾아간다. 영상 데이터는 읽지 않는다.
// 경로나 입출력 문제, MKV/WebM이 아닌 파일은 FcError를 낸다. 읽기 한도를 넘어도 FcError를 낸다. 요소 안쪽의 손상은 찾은 값까지만 돌려준다. 깨진 파일 판별기는 아니다.
function readMkvMetadata(dir, p) {
  try {
    const access = grant(dir, ['read']);
    return parseMkv(access.target, access.read(p), p);
  } catch (err) {
    if (err.syscall) throw new FcError(`MKV 파일을 읽을 수 없습니다: ${p} (${err.code})`);
    throw err;
  }
}

function parseMkv(target, real, p) {
  const size = fileSizeInside(target, real);
  const read = makeReader(target, real, p, size);
  const segment = headerAt(read, checkHeader(read, p));
  if (!segment || segment.id !== ID.SEGMENT) throw new FcError(`MKV/WebM 형식이 아닙니다: ${p}`);
  const segmentEnd = segment.size === null ? size : Math.min(size, segment.start + segment.size);

  const found = { title: null, duration: null, width: null, height: null, displayWidth: null, displayHeight: null };
  const tags = new Map();
  const positions = [];
  const seen = new Set();
  const handle = (header) => {
    if (header.size === null || header.size > MAX_ELEMENT || header.start + header.size > segmentEnd) return;
    const body = read(header.start, header.size);
    if (header.id === ID.SEEK_HEAD) parseSeekHead(body, positions);
    if (header.id === ID.INFO) parseInfo(body, found);
    if (header.id === ID.TRACKS) parseTracks(body, found);
    if (header.id === ID.TAGS) parseTags(body, tags);
  };

  // 크기를 모르는 요소나 첫 Cluster를 만나면 순서대로 읽기를 멈춘다. 영상 데이터를 훑지 않기 위해서다.
  let offset = segment.start;
  while (offset < segmentEnd) {
    const header = headerAt(read, offset);
    if (!header || header.id === ID.CLUSTER || header.size === null) break;
    if (WANTED.has(header.id)) {
      seen.add(offset);
      handle(header);
    }
    offset = header.start + header.size;
  }

  // SeekHead가 다른 SeekHead를 가리킬 수 있어 목록이 늘어나는 동안 계속 본다. 본 위치는 다시 읽지 않으니 끝난다.
  for (const { id, position } of positions) {
    const at = segment.start + position;
    if (at >= segmentEnd || seen.has(at)) continue;
    seen.add(at);
    const header = headerAt(read, at);
    if (header?.id === id) handle(header);
  }

  const duration = found.duration;
  const bitrate = duration ? Math.round((size * 8) / duration) : null;
  return {
    title: found.title ?? tags.get('TITLE') ?? null,
    comment: tags.get('COMMENT') ?? tags.get('DESCRIPTION') ?? null,
    duration,
    width: found.width,
    height: found.height,
    displayWidth: found.displayWidth,
    displayHeight: found.displayHeight,
    bitrate: Number.isFinite(bitrate) && bitrate > 0 ? bitrate : null,
  };
}

// MKV/WebM의 구조가 온전한지 본다. 손상이면 { status: 'broken', reason }을, 의심스러우면 { status: 'suspect', reason }을, 문제를 찾지 못하면 null을 돌려준다.
// 입출력 문제와 읽기 한도 초과는 예외로 나간다.
// Segment 바로 아래 요소의 머리글을 차례로 건너뛰며 파일 끝을 넘는 요소와 Tracks를 본다. 영상 데이터는 읽지 않으므로 Cluster 안의 손상은 찾지 못한다.
// 크기를 모르는 요소(실시간 녹화)를 만나면 끝을 알 수 없으므로 거기서 판단을 멈춘다.
function checkMkvStructure(target, real, p) {
  const broken = (reason) => ({ status: 'broken', reason });
  const size = fileSizeInside(target, real);
  const read = makeReader(target, real, p, size);
  const ebml = headerAt(read, 0);
  if (!ebml || ebml.id !== ID.EBML || ebml.size === null || ebml.size > MAX_ELEMENT) return broken('EBML 머리글이 손상됐습니다.');
  if (ebml.start + ebml.size > size) return broken('EBML 머리글이 잘렸습니다.');
  // Segment 앞에 Void나 CRC가 올 수 있다.
  let segment = headerAt(read, ebml.start + ebml.size);
  while (segment && GLOBAL_ELEMENTS.has(segment.id) && segment.size !== null) segment = headerAt(read, segment.start + segment.size);
  if (!segment || segment.id !== ID.SEGMENT) return broken('Segment 요소가 없습니다. 끝까지 받지 못한 파일일 수 있습니다.');
  if (segment.size !== null && segment.start + segment.size > size) return broken('Segment가 파일 끝을 넘습니다. 잘린 파일일 수 있습니다.');
  const end = segment.size === null ? size : segment.start + segment.size;
  let tracks = false;
  let offset = segment.start;
  while (offset < end) {
    const header = headerAt(read, offset);
    if (!header) {
      // Tracks까지 읽었으면 뒤쪽 패딩일 수 있다.
      if (tracks) return { status: 'suspect', reason: `${offset}바이트 위치부터 요소가 아닌 데이터가 있습니다.` };
      return broken(`${offset}바이트 위치의 요소가 손상됐습니다.`);
    }
    if (header.size === null) return null;
    if (header.start + header.size > end) return broken('요소가 파일 끝을 넘습니다. 잘린 파일일 수 있습니다.');
    if (header.id === ID.TRACKS) tracks = true;
    offset = header.start + header.size;
  }
  return tracks ? null : broken('Tracks 요소가 없습니다.');
}

module.exports = { readMkvMetadata, checkMkvStructure };

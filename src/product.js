'use strict';

// 제품번호 형식: 영문 2~6자, 하이픈, 숫자 2~5자 (ABC-123).
// 앞뒤에 영숫자가 이어지거나(1ABC-123, ABC-123A), 앞에 영문 단어와 하이픈이 있거나(summer-trip-20),
// 뒤에 숫자 묶음이 더 이어지면(PIC-2024-05-01, CVE-2024-1234, ABC-123-01) 제품번호가 아니다.
// 화질 꼬리(ABC-123-1080p, -60fps, -10bit)는 숫자 묶음으로 보지 않는다.
const CANDIDATE = /(?<![A-Za-z0-9])(?<![A-Za-z]-)[A-Za-z]{2,6}-\d{2,5}(?![A-Za-z0-9]|-\d{2}(?!\d*(?:[pPiI]|[fF][pP][sS]|[bB][iI][tT])(?![A-Za-z0-9])))/g;

// 형식은 맞지만 제품번호가 아닌 말. 잘못 찾아 파일 이름을 바꾸는 것보다 못 찾았다고 보고하는 쪽이 안전하므로 넓게 잡는다.
const NOT_PRODUCT = new Set([
  // 순서·묶음
  'PART', 'PARTS', 'DISC', 'DISK', 'CD', 'DVD', 'BD', 'EP', 'VOL', 'NO', 'SEASON', 'DAY', 'WEEK', 'YEAR', 'LESSON', 'PAGE', 'TRACK', 'SCENE', 'TOP',
  // 일반 파일 이름
  'CLIP', 'CLIPS', 'COPY', 'FINAL', 'DRAFT', 'TEST', 'BACKUP', 'SAMPLE', 'FILE', 'FILES', 'VIDEO', 'VIDEOS', 'MOVIE', 'MOVIES', 'FILM', 'IMAGE', 'IMAGES', 'PHOTO', 'PHOTOS', 'AUDIO', 'REPORT', 'VLOG', 'SCAN', 'PIC', 'PICS',
  // 카메라 파일 이름
  'IMG', 'DSC', 'DSCF', 'DSCN', 'VID', 'MOV', 'MVI', 'PXL', 'GOPR', 'DJI', 'DCIM',
  // 화질·코덱·기술·등급 이름
  'HD', 'SD', 'FHD', 'QHD', 'UHD', 'HDR', 'MP', 'MPEG', 'AVC', 'HEVC', 'AAC', 'UTF', 'CP', 'ISO', 'SHA', 'AES', 'MD', 'RFC', 'CVE', 'HTTP', 'WIN', 'OS', 'IOS', 'MACOS', 'OFFICE', 'RTX', 'GTX', 'PG', 'TV', 'TEL',
  // 날짜·연도 앞에 오는 말과 흔한 이름
  'JAN', 'FEB', 'MAR', 'MARCH', 'APR', 'APRIL', 'MAY', 'JUN', 'JUNE', 'JUL', 'JULY', 'AUG', 'AUGUST', 'SEP', 'SEPT', 'OCT', 'NOV', 'DEC', 'FY', 'COVID',
]);

// 전각 영숫자·기호(ＡＢＣ－１２３)만 반각으로 바꾼다. NFKC는 ½, ², ① 같은 글자를 숫자로 풀어 번호 자체를 바꾼다.
function halfWidth(text) {
  return text.replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

// 글에서 제품번호를 찾아 대문자로 바꿔 나온 순서대로 돌려준다. 같은 번호는 한 번만 넣는다.
// 기본은 대문자만 찾는다. 소문자·대소문자 혼합은 summer-2023, Vlog-2024처럼 보통 단어인 경우가 많기 때문이다.
// lowercase를 켜면 전부 소문자인 말(abc-123)도 찾는다. 대소문자 혼합은 찾지 않는다.
function extractProductNumbers(text, { lowercase = false } = {}) {
  if (typeof text !== 'string') return [];
  const found = new Set();
  for (const [match] of halfWidth(text).matchAll(CANDIDATE)) {
    const letters = match.slice(0, match.indexOf('-'));
    const upper = letters.toUpperCase();
    if (letters !== upper && !(lowercase && letters === letters.toLowerCase())) continue;
    if (!NOT_PRODUCT.has(upper)) found.add(match.toUpperCase());
  }
  return [...found];
}

// 제품번호를 찾아 { number, source, candidates }를 돌려준다. 찾지 못하면 null이다.
// 찾는 순서: 파일명의 대문자 번호, 제목, 폴더명(가까운 폴더부터), 코멘트, 파일명의 소문자 번호.
// - 파일명을 먼저 보는 것은 이미 번호가 들어 있으면 건너뛰기 위해서다.
// - 코멘트는 주소나 다른 글을 담을 수 있어 폴더명보다 뒤에 둔다.
// - 소문자 번호는 파일명에서만 인정하고 맨 뒤에 둔다. abc-123.mp4의 번호를 알아보되 vlog-2024.mp4가 제목의 ABC-123을 가리지 않게 한다.
// number는 처음 찾은 번호이고, candidates에는 찾은 번호가 모두 들어 있어 호출한 쪽이 번호가 엇갈리는 파일을 가려낼 수 있다.
// source는 'fileName', 'title', 'folder', 'comment' 중 하나다.
function findProductNumber(input) {
  const { fileName, title, comment, folders } = input ?? {};
  const sources = [
    ['fileName', fileName, false],
    ['title', title, false],
    ...(folders ?? []).map((folder) => ['folder', folder, false]),
    ['comment', comment, false],
    ['fileName', fileName, true],
  ];
  const candidates = new Map();
  for (const [source, text, lowercase] of sources) {
    for (const number of extractProductNumbers(text, { lowercase })) {
      if (!candidates.has(number)) candidates.set(number, { number, source });
    }
  }
  if (candidates.size === 0) return null;
  const list = [...candidates.values()];
  return { number: list[0].number, source: list[0].source, candidates: list };
}

module.exports = { extractProductNumbers, findProductNumber };

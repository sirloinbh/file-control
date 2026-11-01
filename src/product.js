'use strict';

// 제품번호 형식: 영문 2~6자, 하이픈, 숫자 2~5자 (ABC-123).
// 앞뒤에 영숫자가 이어지거나(1ABC-123, ABC-123A) 앞에 영문 단어와 하이픈이 있으면(summer-trip-20) 제품번호가 아니다.
const CANDIDATE = /(?<![A-Za-z0-9])(?<![A-Za-z]-)[A-Za-z]{2,6}-\d{2,5}(?![A-Za-z0-9])/g;

// 형식은 맞지만 제품번호가 아닌 말. 잘못 찾아 파일 이름을 바꾸는 것보다 못 찾았다고 보고하는 쪽이 안전하므로 넓게 잡는다.
const NOT_PRODUCT = new Set([
  // 순서·묶음
  'PART', 'DISC', 'DISK', 'CD', 'DVD', 'BD', 'EP', 'VOL', 'NO', 'SEASON', 'PAGE', 'TRACK', 'SCENE', 'CLIP', 'COPY', 'FINAL', 'BACKUP', 'SAMPLE', 'FILE', 'VIDEO', 'MOVIE', 'IMAGE', 'PHOTO', 'REPORT',
  // 카메라 파일 이름
  'IMG', 'DSC', 'DSCF', 'DSCN', 'VID', 'MOV', 'MVI', 'PXL', 'GOPR', 'DJI', 'DCIM',
  // 화질·코덱·기술 이름
  'HD', 'SD', 'FHD', 'QHD', 'UHD', 'MP', 'MPEG', 'AVC', 'HEVC', 'AAC', 'UTF', 'ISO', 'WIN', 'OS', 'IOS', 'RTX', 'GTX',
  // 날짜·연도 앞에 오는 말과 흔한 이름
  'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'SEPT', 'OCT', 'NOV', 'DEC', 'FY', 'COVID',
]);

// 글에서 제품번호를 찾아 대문자로 바꿔 나온 순서대로 돌려준다. 같은 번호는 한 번만 넣는다.
// 전각 글자(ＡＢＣ－１２３)도 찾는다. 대소문자가 섞인 말(Vlog-2024, Report-2023)은 보통 단어이므로 잡지 않는다.
function extractProductNumbers(text) {
  if (typeof text !== 'string') return [];
  const found = new Set();
  for (const [match] of text.normalize('NFKC').matchAll(CANDIDATE)) {
    const letters = match.slice(0, match.indexOf('-'));
    if (letters !== letters.toUpperCase() && letters !== letters.toLowerCase()) continue;
    if (!NOT_PRODUCT.has(letters.toUpperCase())) found.add(match.toUpperCase());
  }
  return [...found];
}

// 파일명, 메타데이터 제목, 코멘트, 폴더명(가까운 폴더부터) 순으로 제품번호를 찾는다. 찾지 못하면 null이다.
// 파일명을 먼저 보는 것은 이미 번호가 들어 있으면 건너뛰기 위해서이고, 코멘트는 다른 글을 인용할 수 있어 제목보다 뒤에 둔다.
// { number, source, candidates }를 돌려준다. number는 처음 찾은 번호이고, candidates에는 찾은 번호가 모두 들어 있어
// 호출한 쪽이 번호가 엇갈리는 파일을 가려낼 수 있다. source는 'fileName', 'title', 'comment', 'folder' 중 하나다.
function findProductNumber({ fileName, title, comment, folders = [] } = {}) {
  const sources = [
    ['fileName', fileName],
    ['title', title],
    ['comment', comment],
    ...folders.map((folder) => ['folder', folder]),
  ];
  const candidates = new Map();
  for (const [source, text] of sources) {
    for (const number of extractProductNumbers(text)) {
      if (!candidates.has(number)) candidates.set(number, { number, source });
    }
  }
  if (candidates.size === 0) return null;
  const list = [...candidates.values()];
  return { number: list[0].number, source: list[0].source, candidates: list };
}

module.exports = { extractProductNumbers, findProductNumber };

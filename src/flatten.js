'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FcError, remove, hiddenOrSystemEntries, recycleEmptyFolders, recycleBinState, bareDeviceInside, MAX_RECYCLE_PATH } = require('./commands');
const { extractProductNumbers } = require('./product');
const { grant, walk, isInside } = require('./target');

// NTFS 파일 이름 한도 (UTF-16 글자 수)
const MAX_NAME = 255;

// toLowerCase는 문맥을 봐서 NTFS에서 같은 이름인 ΑΣ와 ασ를 다르게 만드므로 대문자로 맞춘다.
function nameKey(name) {
  return process.platform === 'win32' ? name.toUpperCase() : name;
}

// 이름이 비어 있는지 본다. 계획한 이름뿐 아니라 실제 항목도 확인해야 8.3 짧은 이름(LONGFI~1.TXT)과의 겹침이 잡힌다.
// 한도를 넘는 이름은 파일 시스템에 물어볼 수 없으니 그대로 돌려보내 호출한 쪽에서 건너뛰게 한다.
function isTaken(name, target, taken) {
  if (taken.has(nameKey(name))) return true;
  if (name.length > MAX_NAME) return false;
  try {
    return Boolean(fs.lstatSync(path.join(target, name), { throwIfNoEntry: false }));
  } catch (err) {
    throw new FcError(`경로를 확인할 수 없습니다: ${name} (${err.code})`);
  }
}

// a.mkv가 겹치면 a (2).mkv, a (3).mkv 순으로 비어 있는 이름을 찾는다.
// 같은 이름이 많을 때 매번 2부터 다시 찾지 않도록 이름별 다음 번호를 기억한다.
function freeName(name, target, taken, nextNumber) {
  if (!isTaken(name, target, taken)) return name;
  const { name: base, ext } = path.parse(name);
  const key = nameKey(name);
  for (let n = nextNumber.get(key) ?? 2; ; n++) {
    const candidate = `${base} (${n})${ext}`;
    if (!isTaken(candidate, target, taken)) {
      nextNumber.set(key, n + 1);
      return candidate;
    }
  }
}

// 폴더 이름의 끝이 확장자처럼 보이는지 본다. Movie.2021.1080p처럼 숫자로 시작하는 끝부분은 확장자로 보지 않는다.
const EXTENSION_LIKE = /\.(?:[A-Za-z][A-Za-z0-9]{0,9}|7z)$/;

// 이름에 정보가 없는 파일명. 이런 파일만 제품번호 폴더 이름으로 바꾼다. 계약서, ko 같은 이름은 지우면 정보를 잃는다.
const GENERIC_NAME = /^(?:[A-Z]|VIDEO|MOVIE|FILM|CLIP|FILE|IMAGE|PHOTO|AUDIO|SAMPLE|UNTITLED|영상|동영상|파일)$/;

// GENERIC_NAME에서 한 글자 이름을 뺀 것. a, o처럼 한 글자는 줄임말일 수 있어 제품번호가 아닌 폴더 이름으로는 바꾸지 않는다(#71).
const GENERIC_WORD = /^(?:VIDEO|MOVIE|FILM|CLIP|FILE|IMAGE|PHOTO|AUDIO|SAMPLE|UNTITLED|영상|동영상|파일)$/;

// 폴더 이름에 이것들만 있으면 정보가 없다고 본다. 영상 종류·화질·코덱 같은 말과 흔한 폴더 이름이다.
const PLAIN_FOLDER_WORD = /^(?:VIDEOS?|MOVIES?|FILMS?|CLIPS?|FILES?|IMAGES?|PHOTOS?|AUDIO|SAMPLES?|UNTITLED|영상|동영상|파일|DOWNLOADS?|SUBS?|SUBTITLES?|자막|NEW|FOLDER|TEMP|TMP|새|폴더|[HX]\.?26[45]|HEVC|AVC|AV1|\d{3,4}[PI]|[248]K|UHD|FHD|HD|SD|BD\d*|BDRIP|BLURAY|WEB|WEBRIP|DL|DVD|DVDRIP|HDR|SDR|AAC|AC3|DTS)$/;

// PLAIN_FOLDER_WORD 중 화질·코덱만 나타내는 말. 혼자서는 이름이 되지 못하지만 같은 영상의 판을 구분한다(#150).
const QUALITY_WORD = /^(?:[HX]\.?26[45]|HEVC|AVC|AV1|\d{3,4}[PI]|[248]K|UHD|FHD|HD|SD|BD\d*|BDRIP|BLURAY|WEB|WEBRIP|DL|DVD|DVDRIP|HDR|SDR|AAC|AC3|DTS)$/;

// Windows가 새 폴더에 붙이는 이름. 번호가 붙어도 정보가 없다.
const DEFAULT_FOLDER = /^(?:새 폴더|New folder)(?: \(\d+\))?$/i;

// 정보 없는 파일명 대신 쓸 만한 폴더 이름이면 true(#71). 제품번호가 있거나, 위의 흔한 말이 아닌 단어가 하나라도 있으면 된다.
// 전각 글자(Ｖｉｄｅｏ)는 NFKC로 맞춰 보고, 탐색기가 붙이는 번호·복사본 표시(Downloads (2), 새 폴더 - 복사본)는 떼고 본다(1차 리뷰).
// 한 글자뿐인 폴더 이름(a/)은 줄임말일 수 있어 쓰지 않는다.
function informativeFolder(folder) {
  if (extractProductNumbers(folder).length > 0) return true;
  const plain = folder.normalize('NFKC').trim().replace(/(?:\s*\(\d+\)|\s+-\s+(?:복사본|Copy))+$/i, '');
  if (DEFAULT_FOLDER.test(plain)) return false;
  const folderWords = words(plain);
  if (folderWords.join('').length < 2) return false;
  return folderWords.some((word) => !PLAIN_FOLDER_WORD.test(word));
}

// 접두어 사이에 함께 붙일 가까운 폴더인지 본다(#150). 쓸 만한 이름이거나 화질·코덱만 있는 이름(1080p, WEB-DL)이면 된다.
// Subs·자막·Videos·새 폴더 같은 담는 폴더 이름은 붙이지 않는다. 붙이면 ABC-123/Subs/video.en.srt가 ABC-123/video.mp4와 짝을 잃는다.
function distinguishingFolder(folder) {
  if (informativeFolder(folder)) return true;
  const folderWords = words(folder.normalize('NFKC'));
  return folderWords.length > 0 && folderWords.every((word) => QUALITY_WORD.test(word));
}

// 정보 없는 파일명이 가까운 폴더 이름(CD1)을 받았을 때, 유일한 파일이 아닌 바깥 폴더의 제품번호나 제목을 앞에 붙인다(#150).
// ABC-123/CD1/video.mp4, ABC-123/CD2/video.mp4는 ABC-123 CD1.mp4, ABC-123 CD2.mp4가 된다. 받은 이름에 제품번호가 있거나,
// 바깥 이름이 이미 들어 있거나, 붙이면 길이 한도를 넘으면 받은 이름을 그대로 돌려준다.
// outer는 유일한 파일이 아닌 바깥 폴더들(가까운 쪽부터)이다.
function withOuterFolder(fileName, detailed, outer) {
  const { name: base, ext } = path.parse(fileName);
  if (!GENERIC_WORD.test(words(base).join(''))) return detailed;
  const chosen = detailed.slice(0, detailed.length - ext.length);
  if (extractProductNumbers(chosen).length > 0) return detailed;
  const stems = outer.filter((folder) => !folder.startsWith('.') && !EXTENSION_LIKE.test(folder));
  const pick = stems.find((stem) => extractProductNumbers(stem).length > 0) ?? stems.find(informativeFolder);
  if (pick === undefined || containsWords(words(chosen), words(pick).join(''))) return detailed;
  const combined = `${pick.normalize('NFC')} ${detailed}`;
  return combined.length > MAX_NAME ? detailed : combined;
}

// 공백·기호·대소문자 차이를 빼고 단어로 나눈다.
function words(name) {
  return name.normalize('NFC').toUpperCase().split(/[\s\-_.()[\]]+/).filter(Boolean);
}

// 폴더의 이어진 단어들을 붙인 것이 파일 이름과 같으면 true. 글자 단위로 찾으면 v와 movie, 2와 2021처럼 우연히 겹친다.
function containsWords(folderWords, fileText) {
  return folderWords.some((_, start) => {
    let joined = '';
    for (let i = start; i < folderWords.length && joined.length < fileText.length; i++) joined += folderWords[i];
    return joined === fileText;
  });
}

// 폴더명이 파일명보다 자세하면 true. 판단이 서지 않으면 파일 이름을 지키도록 false를 돌려준다.
// 길이만으로는 고르지 않는다. 파일 이름의 정보(날짜, 화질, 언어, 번호)는 지우면 되돌릴 수 없다.
// loose가 true면 정보 없는 파일명에 제품번호가 아닌 폴더 이름도 쓴다(#71).
function isMoreDetailed(folder, base, loose = false) {
  const folderWords = words(folder);
  const baseWords = words(base);
  const f = folderWords.join('');
  const b = baseWords.join('');
  if (f === '' || b === '') return false;
  if (f.length > b.length && containsWords(folderWords, b)) return true;
  if (b.includes(f)) return false;
  if (extractProductNumbers(folder).length > 0 && GENERIC_NAME.test(b)) return true;
  // video.mp4처럼 정보 없는 파일명은 제품번호로 인정되지 않는 폴더 이름(PART-01, BD-123)이라도 쓴다. 그대로 두면 폴더가 지워지며 그 정보를 잃는다(#71).
  return loose && GENERIC_WORD.test(b) && informativeFolder(folder);
}

// 파일 이름과 폴더 이름(가까운 폴더부터) 중 가장 자세한 이름을 확장자를 유지해 돌려준다.
function detailedName(fileName, folders) {
  const { name: base, ext } = path.parse(fileName);
  // 확장자가 없으면 폴더 이름의 끝이 확장자가 될 수 있고(data + data.zip/), .env.local 같은 점 파일은 이름이 곧 정체다.
  // .tar.gz는 폴더 이름을 붙이면 .gz만 남아 형식을 잃는다. Dr. Strange의 ". Strange"는 확장자가 아니다.
  if (ext === '' || /\s/.test(ext) || fileName.startsWith('.') || /\.tar$/i.test(base)) return fileName;
  const pick = (loose) => {
    let best = base;
    for (const folder of folders) {
      // 폴더 이름에 같은 확장자가 들어 있으면(ABC-123.mp4/) 겹치지 않게 빼고, 다른 확장자면 이중 확장자가 되므로 쓰지 않는다.
      const stem = folder.toUpperCase().endsWith(ext.toUpperCase()) ? folder.slice(0, -ext.length) : folder;
      // .trash-1000 같은 점 폴더 이름을 쓰면 숨김 파일이 된다.
      if (!stem.startsWith('.') && !EXTENSION_LIKE.test(stem) && isMoreDetailed(stem, best, loose)) best = stem.normalize('NFC');
    }
    return best;
  };
  // 제품번호 폴더를 먼저 찾는다. 없을 때만 정보 없는 파일명에 다른 폴더 이름을 쓰므로, 가까운 summer-2023/이 바깥 ABC-123/을 밀어내지 않는다.
  const strict = pick(false);
  return (strict === base ? pick(true) : strict) + ext;
}

// 정보 없는 파일명이 폴더 안의 유일한 파일이 아니어서 폴더 이름으로 바꿀 수 없을 때, 가까운 폴더 이름을 앞에 붙인 이름을 돌려준다(#71).
// ABC-123/video.mp4와 ABC-123/sample.mp4는 ABC-123 video.mp4, ABC-123 sample.mp4가 된다. 원래 이름을 남겨 서로 구분되고,
// 본편과 샘플이 같은 이름을 다투지 않는다. 붙일 수 없으면 원래 이름을 돌려준다.
// folders는 가까운 폴더부터 바깥 폴더 순이다. 가까운 폴더가 1080p/처럼 정보가 없으면 위로 올라가 처음 만나는 쓸 만한 폴더 이름을 붙인다(1차 리뷰).
// 정보 없는지는 첫 점 앞부분으로 본다. video.en.srt도 video.mp4와 같은 접두어를 받아 자막 짝이 유지된다. 앞에 붙이기만 하므로 정보를 잃지 않는다.
function prefixedName(fileName, folders) {
  const { name: base, ext } = path.parse(fileName);
  if (ext === '' || /\s/.test(ext) || fileName.startsWith('.') || /\.tar$/i.test(base)) return fileName;
  const b = words(base.split('.')[0]).join('');
  if (!GENERIC_NAME.test(b)) return fileName;
  // 폴더 하나(문자열)나 없는 값도 받는다.
  const stems = [folders]
    .flat()
    .filter((folder) => folder !== undefined)
    .map((folder) => (folder.toUpperCase().endsWith(ext.toUpperCase()) ? folder.slice(0, -ext.length) : folder))
    .filter((stem) => stem.trim() !== '' && !stem.startsWith('.') && !EXTENSION_LIKE.test(stem));
  // detailedName처럼 제품번호 폴더를 먼저 찾아, ABC-123/Extras/video.mp4가 Extras 대신 ABC-123을 붙이게 한다(2차 리뷰).
  const chosen = stems.find((stem) => extractProductNumbers(stem).length > 0) ?? (GENERIC_WORD.test(b) ? stems.find(informativeFolder) : undefined);
  if (chosen === undefined) return fileName;
  // 고른 폴더와 파일 사이의 가까운 폴더 이름(1080p, CD1)도 바깥부터 함께 붙인다(#150). Show/1080p/video.mp4와 Show/720p/video.mp4가
  // Show video.mp4, Show video (2).mp4가 되어 화질 구분을 잃지 않게 한다. 이미 들어 있는 이름은 다시 붙이지 않는다.
  let prefix = chosen.normalize('NFC');
  for (const stem of stems.slice(0, stems.indexOf(chosen)).reverse()) {
    if (!distinguishingFolder(stem) || containsWords(words(prefix), words(stem).join(''))) continue;
    prefix = `${prefix} ${stem.normalize('NFC')}`;
  }
  const combined = `${prefix} ${fileName}`;
  return combined.length > MAX_NAME ? `${chosen.normalize('NFC')} ${fileName}` : combined;
}

// mv·zip이 실패했을 때 남긴 잔여물. 오류 메시지가 알려 준 위치에 그대로 있어야 복구할 수 있으니 옮기지 않는다.
const LEFTOVER = /^\.fctl-(?:old|new)-\d+-\d+-\d+(?:\.|$)/;

// Windows가 관리하는 폴더. 안쪽 파일을 꺼내면 복원 정보와 함께 망가진다.
const SYSTEM_FOLDER = /^(?:\$RECYCLE\.BIN|System Volume Information)$/i;

// 폴더를 꾸미거나 미리보기를 담아 두는 파일. 그 폴더에서만 뜻이 있어, 옮기면 타겟 바로 아래에 desktop (2).ini처럼 쌓인다(#65).
// 옮기지 않고 파일 수에도 넣지 않으며, 폴더가 비면 폴더와 함께 휴지통으로 간다.
const FOLDER_METADATA = /^(?:desktop\.ini|thumbs\.db|ehthumbs(?:_vista)?\.db|\.DS_Store)$/i;
const FOLDER_METADATA_NAMES = ['desktop.ini', 'thumbs.db', 'ehthumbs.db', 'ehthumbs_vista.db', '.ds_store'];

const isFolderMetadata = (entry) => entry.type === 'file' && FOLDER_METADATA.test(path.basename(entry.relative));

// 이름만으로 프로그램이 쓰는 폴더로 보는 것. 프로그램이 안쪽 구조와 이름으로 파일을 찾으므로 흩어지면 동작하지 않는다(#65).
const PROGRAM_FOLDER = /^(?:node_modules|bower_components|__pycache__|site-packages)$/i;

// 있으면 그 폴더를 프로젝트나 파이썬 가상환경 폴더로 보는 파일.
const PROJECT_FILE = /^(?:package\.json|pyvenv\.cfg|pyproject\.toml|setup\.py|Cargo\.toml|go\.mod|pom\.xml|build\.gradle(?:\.kts)?|CMakeLists\.txt|composer\.json|Gemfile|.+\.(?:sln|csproj|vcxproj|fsproj|vbproj))$/i;

// 옮기지 않고 통째로 남길 폴더를 { 상대경로 -> 사유 }로 돌려준다(#65). 프로그램 폴더, 프로젝트 폴더, 실행 파일과 DLL이 함께 든 폴더,
// 숨김 속성 폴더다. 안쪽만 남기고 옆 파일을 꺼내도 프로그램이 깨지므로 그 폴더 아래 전체를 남긴다.
// 시스템 속성만 있는 폴더는 폴더 아이콘을 꾸밀 때 흔히 붙으므로(desktop.ini와 함께) 일반 폴더로 다룬다(1차 리뷰).
// attributes는 hiddenOrSystemEntries가 돌려준 { 상대경로 -> 속성 비트(숨김 2, 시스템 4) }다.
// 타겟 자신이 이런 폴더이거나 프로그램 폴더 안이면 모든 하위 폴더가 프로그램의 일부라 거부한다.
function guardedFolders(target, entries, attributes) {
  for (let dir = target; ; dir = path.dirname(dir)) {
    if (PROGRAM_FOLDER.test(path.basename(dir))) throw new FcError(`프로그램 폴더 안이라 다루지 않습니다: ${dir}`);
    if (dir === path.dirname(dir)) break;
  }
  rejectProjectAncestor(target);
  const guarded = new Map();
  const add = (relative, reason) => {
    if (!guarded.has(relative)) guarded.set(relative, reason);
  };
  const programs = new Map();
  for (const entry of entries) {
    const name = path.basename(entry.relative);
    const parent = path.dirname(entry.relative);
    if (entry.type === 'dir') {
      if (PROGRAM_FOLDER.test(name)) add(entry.relative, `프로그램 폴더(${name})`);
      else if ((attributes.get(entry.relative) ?? 0) & 2) add(entry.relative, '숨김 속성 폴더');
      continue;
    }
    if (entry.type !== 'file') continue;
    if (PROJECT_FILE.test(name)) {
      if (parent === '.') throw new FcError(`타겟이 프로젝트 폴더로 보여(${name} 있음) 다루지 않습니다. 그 아래 폴더를 타겟으로 고르세요: ${target}`);
      add(parent, `프로젝트 폴더(${name} 있음)`);
    }
    const ext = path.extname(name).toLowerCase();
    if (ext === '.exe' || ext === '.dll') programs.set(parent, new Set([...(programs.get(parent) ?? []), ext]));
  }
  for (const [parent, kinds] of programs) {
    if (kinds.size < 2) continue;
    if (parent === '.') throw new FcError(`타겟에 실행 파일과 DLL이 함께 있어 프로그램 폴더로 보고 다루지 않습니다. 그 아래 폴더를 타겟으로 고르세요: ${target}`);
    add(parent, '실행 파일과 DLL이 함께 든 프로그램 폴더');
  }
  return guarded;
}

// 프로젝트 표시 파일이나 실행 파일·DLL이 우연히 놓이기 쉬운 곳인지 본다(#148). 드라이브 루트, 사용자 폴더와 그 위,
// 사용자 폴더 바로 아래(다운로드, 바탕화면, 문서 등), OneDrive 폴더 바로 아래(OneDrive\Desktop 등)는 내려받은 package.json이나
// 설치 파일이 놓여도 프로젝트로 보지 않는다. 그 아래 폴더(다운로드\myproj)부터는 본다.
// 사용자가 만든 폴더(사용자 폴더\myproj)는 터미널 기본 위치라 프로젝트가 흔히 생기므로 정해진 이름만 건너뛴다(1차 리뷰).
function isCommonPlace(dir, home) {
  if (dir === path.dirname(dir)) return true;
  if (!home) return false;
  if (isInside(dir, home)) return true;
  const name = path.basename(dir);
  const parent = path.dirname(dir);
  if (path.relative(home, parent) === '') return HOME_FOLDER.test(name) || ONEDRIVE.test(name);
  return path.relative(home, path.dirname(parent)) === '' && ONEDRIVE.test(path.basename(parent)) && ONEDRIVE_FOLDER.test(name);
}

// 사용자 폴더 바로 아래의 기본 폴더. 디스크의 이름은 한국어 Windows에서도 영어다.
const HOME_FOLDER = /^(?:Downloads|Desktop|Documents|Pictures|Videos|Music|Favorites|Links|Saved Games|Searches|Contacts|3D Objects)$/i;
// OneDrive 폴더(OneDrive, OneDrive - 회사)와 그 바로 아래에서 동기화하는 기본 폴더. OneDrive 쪽은 표시 언어 이름으로 만들어진다.
const ONEDRIVE = /^OneDrive(?:$| - )/i;
const ONEDRIVE_FOLDER = /^(?:Desktop|Documents|Pictures|Videos|Music|Attachments|바탕 화면|문서|사진|동영상|음악|첨부 파일)$/i;

// 사용자 폴더의 실제 경로. 알 수 없으면 빈 문자열을 돌려주고, 그때는 드라이브 루트만 건너뛴다(더 많이 막는 쪽).
function realHome() {
  let home;
  try {
    home = os.homedir();
  } catch {
    return '';
  }
  if (!home || !path.isAbsolute(home)) return '';
  try {
    return fs.realpathSync.native(home);
  } catch {
    return path.resolve(home);
  }
}

// 타겟의 위 폴더가 프로젝트 폴더(표시 파일이 바로 안에 있음)나 프로그램 폴더(실행 파일과 DLL이 함께 있음)면 거부한다(#148).
// myproj/package.json이 있을 때 myproj/src를 흩으면 프로젝트가 깨지고, 저장소가 없으면 되돌릴 수 없다.
// 위 폴더를 모두 보되 isCommonPlace인 곳은 건너뛴다. 단계 수로 자르지 않는다(myproj/src/a/b도 막는다).
function rejectProjectAncestor(target) {
  const home = realHome();
  for (let dir = path.dirname(target); ; dir = path.dirname(dir)) {
    if (!isCommonPlace(dir, home)) {
      let names;
      try {
        names = fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name);
      } catch (err) {
        throw new FcError(`위 폴더가 프로젝트 폴더인지 확인할 수 없습니다: ${dir} (${err.code})`);
      }
      const marker = names.find((name) => PROJECT_FILE.test(name));
      if (marker) throw new FcError(`위 폴더가 프로젝트 폴더로 보여(${marker} 있음) 다루지 않습니다: ${dir}`);
      const exts = new Set(names.map((name) => path.extname(name).toLowerCase()));
      if (exts.has('.exe') && exts.has('.dll')) throw new FcError(`위 폴더에 실행 파일과 DLL이 함께 있어 프로그램 폴더로 보고 다루지 않습니다: ${dir}`);
    }
    if (dir === path.dirname(dir)) break;
  }
}

// 경로가 남길 폴더 아래면 가장 바깥의 그 폴더 상대경로를, 아니면 undefined를 돌려준다.
function guardOf(relative, guarded) {
  const parts = relative.split(path.sep);
  for (let depth = 1; depth <= parts.length; depth++) {
    const folder = parts.slice(0, depth).join(path.sep);
    if (guarded.has(folder)) return folder;
  }
  return undefined;
}

// 파일이 그 폴더(하위 포함)의 유일한 항목일 때만 폴더 이름을 쓸 수 있다. 여럿이면 ep1, ep2 같은 구분을 잃는다.
function soleFolders(entry, fileCounts) {
  const parts = entry.relative.split(path.sep).slice(0, -1);
  const folders = [];
  for (let depth = parts.length; depth > 0; depth--) {
    if (fileCounts.get(parts.slice(0, depth).join(path.sep)) !== 1) break;
    folders.push(parts[depth - 1]);
  }
  return folders;
}

// 폴더마다 안에 든 파일과 링크 수를 하위까지 합쳐 센다. 폴더 설정·미리보기 파일(desktop.ini 등)은 세지 않는다.
function countFiles(entries) {
  const counts = new Map();
  for (const entry of entries) {
    if (entry.type === 'dir' || isFolderMetadata(entry)) continue;
    const parts = entry.relative.split(path.sep).slice(0, -1);
    for (let depth = 1; depth <= parts.length; depth++) {
      const key = parts.slice(0, depth).join(path.sep);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

// 버전 관리 폴더. 안쪽 구조가 곧 내용이라 흩어지면 복구할 수 없다.
const REPOSITORY_FOLDER = /^\.(?:git|hg|svn|jj)$/i;

// HEAD, objects, refs가 함께 있으면 Git 저장소 폴더다. 베어 저장소(backup.git)처럼 이름이 .git이 아니어도 잡는다.
function looksLikeGitDir(dir) {
  const stat = (name) => fs.statSync(path.join(dir, name), { throwIfNoEntry: false });
  try {
    return Boolean(stat('HEAD')?.isFile() && stat('objects')?.isDirectory() && stat('refs')?.isDirectory());
  } catch (err) {
    throw new FcError(`저장소인지 확인할 수 없습니다: ${dir} (${err.code})`);
  }
}

// 저장소는 폴더 구조 자체가 내용이라, .git 안쪽만 건너뛰어도 작업 파일이 흩어져 복구할 수 없다. 일부만 옮기지 않고 거부한다.
// 타겟이 저장소의 일반 하위 폴더(r/src)면 저장소는 망가지지 않고 git으로 되돌릴 수 있으므로 막지 않는다.
function rejectRepository(target, entries) {
  for (let dir = target; ; dir = path.dirname(dir)) {
    if (REPOSITORY_FOLDER.test(path.basename(dir)) || looksLikeGitDir(dir)) throw new FcError(`저장소 내부 폴더라 다루지 않습니다: ${dir}`);
    if (dir === path.dirname(dir)) break;
  }
  const folder = entries.find((entry) => entry.relative.split(path.sep).some((part) => REPOSITORY_FOLDER.test(part)));
  if (folder) throw new FcError(`저장소가 들어 있어 다루지 않습니다: ${folder.path}`);
  const bare = entries.find((entry) => entry.type === 'file' && path.basename(entry.path) === 'HEAD' && looksLikeGitDir(path.dirname(entry.path)));
  if (bare) throw new FcError(`저장소가 들어 있어 다루지 않습니다: ${path.dirname(bare.path)}`);
}

// 타겟 아래 모든 파일을 타겟 바로 아래로 옮기는 계획을 만든다. 파일은 건드리지 않는다.
// - moves: 옮길 파일 ({ from, to, name, desired, fromFolder, numbered }). desired는 번호를 붙이기 전의 이름이다. 폴더명이 더 자세하면 fromFolder가 true다.
//   이름이 겹치면 번호를 붙이고 numbered가 true다. 이미 있는 이름은 폴더라도 피한다.
// - stay: 이미 타겟 바로 아래에 있어 그대로 두는 항목의 경로
// - skipped: 옮기지 않는 항목 ({ path, reason }). 링크와 grant가 거부하는 이름은 조용히 빠지지 않게 사유를 남긴다.
//   통째로 남기는 폴더(프로그램·프로젝트·숨김 폴더)는 안의 파일마다가 아니라 폴더 하나로 남긴다.
// - guarded: 통째로 남기는 폴더의 상대경로 Set. 빈 폴더 정리도 이 폴더와 그 위를 남긴다.
function planFlatten(dir) {
  const access = grant(dir, ['read', 'write']);
  const entries = walk(access.target);
  rejectRepository(access.target, entries);
  // walk가 폴더로 본 곳을 그대로 넘겨 두 판정이 갈리지 않게 한다. node_modules 같은 폴더 안은 통째로 남기므로 보지 않는다.
  const folders = [''].concat(entries.filter((entry) => entry.type === 'dir' && !entry.relative.split(path.sep).some((part) => PROGRAM_FOLDER.test(part))).map((entry) => entry.relative));
  const attributes = hiddenOrSystemEntries(access.target, folders);
  const guarded = guardedFolders(access.target, entries, attributes);
  const guardItems = new Map();
  const isTop = (entry) => !entry.relative.includes(path.sep);
  const taken = new Set(entries.filter(isTop).map((entry) => nameKey(entry.relative)));
  const nextNumber = new Map();
  const fileCounts = countFiles(entries);
  const plan = { target: access.target, moves: [], stay: [], skipped: [], guarded: new Set(guarded.keys()) };
  // 이전 실행이 하드링크를 만든 뒤 멈췄으면 타겟 바로 아래에 같은 파일의 다른 이름(번호가 붙었을 수도 있다)이 있다(#73).
  const topFiles = new Map();
  // 이름을 배정할 파일 ({ from, original, desired, slot, move })
  const candidates = [];
  for (const entry of entries) {
    if (!isTop(entry) || entry.type !== 'file') continue;
    const key = fileKey(entry.path);
    if (key) topFiles.set(key, entry.path);
  }
  for (const entry of entries) {
    if (isTop(entry)) {
      if (entry.type !== 'dir') plan.stay.push(entry.path);
      continue;
    }
    const parts = entry.relative.split(path.sep);
    if (entry.type !== 'dir' && parts.some((part) => LEFTOVER.test(part))) {
      plan.skipped.push({ path: entry.path, reason: '이전 작업의 잔여물이라 옮기지 않습니다.' });
      continue;
    }
    if (entry.type !== 'dir' && parts.some((part) => SYSTEM_FOLDER.test(part))) {
      plan.skipped.push({ path: entry.path, reason: 'Windows 시스템 폴더 안의 파일이라 옮기지 않습니다.' });
      continue;
    }
    const guard = guardOf(entry.relative, guarded);
    if (guard !== undefined) {
      if (entry.type === 'dir') continue;
      let item = guardItems.get(guard);
      if (!item) {
        item = { path: path.join(access.target, guard), label: guarded.get(guard), count: 0 };
        guardItems.set(guard, item);
        plan.skipped.push(item);
      }
      item.count += 1;
      continue;
    }
    if (entry.type === 'dir') continue;
    if (entry.type === 'link') {
      plan.skipped.push({ path: entry.path, reason: '링크는 옮기지 않습니다.' });
      continue;
    }
    if (isFolderMetadata(entry)) {
      plan.skipped.push({ path: entry.path, reason: '폴더 설정·미리보기 파일이라 옮기지 않습니다. 폴더가 비면 폴더와 함께 휴지통으로 갑니다.' });
      continue;
    }
    if (attributes.has(entry.relative)) {
      plan.skipped.push({ path: entry.path, reason: '숨김·시스템 속성 파일이라 옮기지 않습니다.' });
      continue;
    }
    const original = path.basename(entry.path);
    try {
      const from = access.read(entry.path);
      // 폴더 이름에 확장자를 붙이면 길이 한도를 넘을 수 있다. 파일을 건너뛰지 않고 원래 이름으로 돌아간다.
      const sole = soleFolders(entry, fileCounts);
      const ancestors = parts.slice(0, -1).reverse();
      let detailed = detailedName(original, sole);
      if (detailed === original) detailed = prefixedName(original, ancestors);
      else detailed = withOuterFolder(original, detailed, ancestors.slice(sole.length));
      // 그 이름을 두고 번호를 붙여 세 번째 이름을 만들지 않는다.
      const twin = topFiles.get(fileKey(from));
      if (twin) throw new FcError(`타겟 바로 아래에 이미 있는 이름이라 옮기지 않습니다: ${path.basename(twin)}${leftoverNote(from, twin)}`);
      // 이름은 아래에서 한꺼번에 배정한다. 실패하면 이 자리에 사유를 채워 건너뜀 순서를 유지한다.
      const slot = { path: entry.path, reason: null };
      plan.skipped.push(slot);
      candidates.push({ from, original, desired: detailed.length > MAX_NAME ? original : detailed, slot });
    } catch (err) {
      if (!(err instanceof FcError)) throw err;
      plan.skipped.push({ path: entry.path, reason: err.message });
    }
  }
  // 원래 이름을 그대로 쓰는 파일에 먼저 이름을 배정한다(#63). 폴더명 후보(ABC-123 제목/x.mp4 → ABC-123 제목.mp4)가
  // 원래 그 이름인 파일(z/ABC-123 제목.mp4)의 이름을 먼저 차지해 번호를 붙이게 하지 않는다. 옮기는 순서는 항목 순서 그대로다.
  // 같은 폴더에서 같은 접두어를 받은 짝(ABC-123/video.mp4, video.en.srt → ABC-123 video.*)은 그보다도 먼저 배정해,
  // 원래 이름 파일(z/ABC-123 video.mp4)과 겹쳐도 짝 중 하나에만 번호가 붙어 짝이 깨지지 않게 한다(1차 리뷰).
  // 키는 붙인 접두어 + 원래 이름의 첫 점 앞부분이다. 접두어 폴더 이름의 점(ABC-123 v1.5)에서 자르지 않고,
  // 하위 폴더에 나뉜 짝(ABC-123/video.mp4, ABC-123/Subs/video.en.srt)도 묶는다(2차 리뷰).
  const pairKey = (c) => {
    if (!c.desired.endsWith(c.original)) return nameKey(c.desired);
    return nameKey(c.desired.slice(0, c.desired.length - c.original.length) + c.original.split('.')[0]);
  };
  const pairSizes = new Map();
  for (const c of candidates) if (c.desired !== c.original) pairSizes.set(pairKey(c), (pairSizes.get(pairKey(c)) ?? 0) + 1);
  const rank = (c) => {
    if (c.desired === c.original) return 1;
    return pairSizes.get(pairKey(c)) > 1 ? 0 : 2;
  };
  const order = [0, 1, 2].flatMap((r) => candidates.filter((c) => rank(c) === r));
  for (const candidate of order) {
    const { from, original } = candidate;
    try {
      let desired = candidate.desired;
      let name = freeName(desired, access.target, taken, nextNumber);
      if (name.length > MAX_NAME && desired !== original) {
        desired = original;
        name = freeName(desired, access.target, taken, nextNumber);
      }
      if (name.length > MAX_NAME) throw new FcError(`번호를 붙이면 이름이 너무 깁니다: ${name}`);
      candidate.move = { from, to: access.write(name), name, desired, fromFolder: desired !== original, numbered: name !== desired };
      taken.add(nameKey(name));
    } catch (err) {
      if (!(err instanceof FcError)) throw err;
      candidate.slot.reason = err.message;
    }
  }
  plan.moves = candidates.filter((c) => c.move).map((c) => c.move);
  const slots = new Set(candidates.map((c) => c.slot));
  plan.skipped = plan.skipped.filter((item) => !slots.has(item) || item.reason !== null);
  for (const item of guardItems.values()) {
    item.reason = `${item.label}라 안의 항목 ${item.count}개를 옮기지 않고 폴더째 남깁니다.`;
    delete item.label;
    delete item.count;
  }
  // 파일이 없는 남길 폴더도 지우지 않는다는 것을 알린다. 다른 남길 폴더 안에 든 것은 바깥 폴더로 이미 알렸다.
  for (const [relative, label] of guarded) {
    if (!guardItems.has(relative) && guardOf(relative, guarded) === relative) plan.skipped.push({ path: path.join(access.target, relative), reason: `${label}라 폴더째 남깁니다.` });
  }
  return plan;
}

// 덮어쓰지 않고 옮긴다. 이미 있으면(8.3 짧은 이름, 대소문자 포함) 아무것도 바꾸지 않고 false를 돌려준다.
// renameSync는 대상을 덮어쓰므로(폴더도 같은 이름의 파일을 덮어쓴다, 빌드 26200에서 확인) 그대로 쓰지 않는다.
// 파일은 새 이름으로 하드링크를 만든 뒤 원래 이름을 지운다(#73). linkSync는 이름이 있으면 EEXIST로 실패하므로 끼어든 파일을 덮어쓰지 않고,
// 중간에 꺼져도 같은 내용의 두 이름이 남을 뿐 빈 파일이 남지 않는다. 원본이 잠겨 원래 이름을 못 지우면 새 이름을 지워 되돌린다.
// 하드링크를 못 만드는 경우(FAT32·exFAT, 클라우드 전용 파일 등)와 폴더는 빈 자리표시 파일을 먼저 만든 뒤 그 위로 옮긴다.
function moveWithoutOverwrite(from, to) {
  if (fs.lstatSync(from).isFile()) {
    try {
      fs.linkSync(from, to);
    } catch (err) {
      if (err.code === 'EEXIST') return false;
      // 실패로 알렸어도 링크가 만들어졌을 수 있다(네트워크 응답 유실 등). 그러면 내가 만든 이름이므로 이어서 원래 이름을 지운다.
      if (!sameFile(from, to)) return moveOverPlaceholder(from, to);
    }
    try {
      fs.unlinkSync(from);
    } catch (err) {
      removeNewName(from, to, err);
      throw err;
    }
    return true;
  }
  return moveOverPlaceholder(from, to);
}

function moveOverPlaceholder(from, to) {
  try {
    fs.closeSync(fs.openSync(to, 'wx'));
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
  try {
    fs.renameSync(from, to);
  } catch (err) {
    removePlaceholder(to, err);
    throw err;
  }
  return true;
}

// 같은 파일인지 파일 번호로 본다. Windows 파일 번호는 64비트라 bigint로 읽는다.
// 파일 번호를 0으로 알리는 파일 시스템(일부 네트워크 드라이브)에서는 서로 다른 파일을 같다고 보지 않도록 같지 않다고 본다.
function sameFile(a, b) {
  const sa = fs.lstatSync(a, { bigint: true, throwIfNoEntry: false });
  const sb = fs.lstatSync(b, { bigint: true, throwIfNoEntry: false });
  return Boolean(sa && sb && sa.ino !== 0n && sa.ino === sb.ino && sa.dev === sb.dev);
}

// 같은 파일을 찾는 열쇠(볼륨:파일 번호). 확인하지 못하거나 파일 번호가 0이면 null이다. 확인하지 못한 사유는 뒤의 이름 고르기가 알린다.
function fileKey(p) {
  try {
    const stat = fs.lstatSync(p, { bigint: true, throwIfNoEntry: false });
    return stat && stat.ino !== 0n ? `${stat.dev}:${stat.ino}` : null;
  } catch {
    return null;
  }
}

// 원래 이름을 지우지 못했으면 만든 하드링크를 지워 되돌린다. 그사이 새 이름이 다른 파일로 바뀌었으면 지우지 않는다.
function removeNewName(from, to, cause) {
  let ours;
  try {
    ours = sameFile(from, to);
  } catch (err) {
    throw new FcError(`옮기지 못했고 새 이름도 확인하지 못했습니다: ${to} (${cause.code}, ${err.code})`);
  }
  if (!ours) {
    if (!fs.lstatSync(to, { throwIfNoEntry: false })) return;
    throw new FcError(`옮기지 못했고 새 이름이 그사이 다른 파일로 바뀌어 지우지 않았습니다: ${to} (${cause.code})`);
  }
  try {
    fs.unlinkSync(to);
  } catch (err) {
    throw new FcError(`옮기지 못했고 새 이름도 지우지 못해 같은 파일이 두 이름으로 남았습니다: ${from}, ${to} (${cause.code}, ${err.code})`);
  }
}

// 대상 이름이 이미 있을 때, 이전 실행이 중간에 멈춰 남긴 것으로 보이면 그 사실을 알리는 문구를 돌려준다(#73).
function leftoverNote(from, to) {
  try {
    if (sameFile(from, to)) return ' (원본과 같은 파일의 다른 이름(하드링크)입니다. 이전 실행이 중간에 멈춘 흔적일 수 있어 한쪽 이름을 지우면 됩니다)';
    const target = fs.lstatSync(to, { throwIfNoEntry: false });
    if (target?.isFile() && target.size === 0 && fs.lstatSync(from).size > 0) {
      return ' (그 이름은 빈 파일입니다. 이전 실행이 중간에 멈추며 남긴 자리표시일 수 있으니 확인한 뒤 지우고 다시 실행하세요)';
    }
  } catch {
    // 알림 문구만 빠진다.
  }
  return '';
}

// 그사이 다른 프로그램이 내용을 썼다면 내 자리표시가 아니므로 지우지 않는다.
function removePlaceholder(to, cause) {
  let stat;
  try {
    stat = fs.lstatSync(to, { throwIfNoEntry: false });
  } catch (err) {
    throw new FcError(`옮기지 못했고 자리표시 파일도 확인하지 못했습니다: ${to} (${cause.code}, ${err.code})`);
  }
  if (!stat) return;
  if (!stat.isFile() || stat.size !== 0) throw new FcError(`옮기지 못했고 자리표시 파일에 다른 내용이 생겨 지우지 않았습니다: ${to} (${cause.code})`);
  try {
    fs.rmSync(to, { force: true, maxRetries: 3 });
  } catch (err) {
    throw new FcError(`옮기지 못했고 빈 자리표시 파일도 지우지 못했습니다: ${to} (${cause.code}, ${err.code})`);
  }
}

// 번호를 다시 고르는 횟수 한도. 다른 프로그램이 계속 같은 이름을 만들 때 끝나지 않는 일을 막는다.
const MAX_ATTEMPTS = 100;

// 계획한 이름이 그사이 찼으면 번호를 다시 고른다. a/longfilename.txt를 옮기면 LONGFI~1.TXT가 새로 차는 것처럼 계획 단계에서 알 수 없다.
function applyMove(move, access, taken, nextNumber) {
  // 계획과 실행 사이에 원본이 링크로 바뀌었거나 타겟 밖을 가리키면 여기서 거부된다.
  const from = access.delete(move.from);
  // 부모가 안쪽을 가리키는 정션으로 바뀌었거나 파일이 폴더로 바뀌면 계획과 다른 항목을 옮기게 된다.
  if (from !== move.from) throw new FcError(`계획 뒤에 경로가 바뀌었습니다: ${move.from} -> ${from}`);
  if (!fs.lstatSync(from).isFile()) throw new FcError(`계획 뒤에 파일이 아니게 됐습니다: ${from}`);
  let name = move.name;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (name.length > MAX_NAME) throw new FcError(`번호를 붙이면 이름이 너무 깁니다: ${name}`);
    const to = path.join(access.target, name);
    // 이미 있는 항목에는 손대지 않는다. 끊어진 정션에 wx로 열면 정션이 가리키는 타겟 밖에 폴더가 생긴다.
    if (!fs.lstatSync(to, { throwIfNoEntry: false })) {
      access.write(name);
      if (moveWithoutOverwrite(from, to)) return { ...move, from, to, name, numbered: name !== move.desired };
    }
    name = freeName(move.desired, access.target, taken, nextNumber);
    taken.add(nameKey(name));
  }
  throw new FcError(`비어 있는 이름을 찾지 못했습니다: ${move.desired}`);
}

// 경로의 상위 폴더를 타겟 기준 상대경로로 돌려준다. 자신이 폴더면 자신도 넣는다.
function folderChain(entry) {
  const parts = entry.relative.split(path.sep);
  const last = entry.type === 'dir' ? parts.length : parts.length - 1;
  return Array.from({ length: last }, (_, i) => parts.slice(0, i + 1).join(path.sep));
}

// 이번에 옮긴 파일이 있던 폴더 중 비게 된 폴더를 가장 위 폴더만 돌려준다. 그 아래 폴더는 함께 지워진다.
// 원래 비어 있던 폴더(Inbox/)는 사용자가 만든 구조일 수 있어 건드리지 않는다. 옮긴 파일이 있던 트리 안의 빈 폴더만 함께 간다.
// 남은 파일과 링크, 잔여물·시스템 폴더와 그 안쪽이 있으면 그 위의 폴더는 모두 남긴다.
function removableFolders(entries, movedFolders, guarded = new Set()) {
  const occupied = new Set();
  for (const entry of entries) {
    // 폴더 설정·미리보기 파일만 남은 폴더는 빈 폴더로 보고 함께 휴지통으로 보낸다(#65).
    if (isFolderMetadata(entry)) continue;
    const protectedDir = entry.type === 'dir' && (entry.relative.split(path.sep).some((part) => LEFTOVER.test(part) || SYSTEM_FOLDER.test(part)) || guardOf(entry.relative, guarded) !== undefined);
    if (entry.type !== 'dir' || protectedDir) for (const folder of folderChain(entry)) occupied.add(folder);
  }
  const free = entries.filter((entry) => entry.type === 'dir' && !occupied.has(entry.relative));
  const freeNames = new Set(free.map((entry) => entry.relative));
  return free.filter((entry) => !freeNames.has(path.dirname(entry.relative)) && movedFolders.has(entry.relative)).map((entry) => entry.path);
}

// 이동한 파일이 있던 폴더와 그 상위 폴더를 타겟 기준 상대경로로 모은다.
function foldersOf(moves, target) {
  const folders = new Set();
  for (const { from } of moves) {
    for (const folder of folderChain({ relative: path.relative(target, from), type: 'file' })) folders.add(folder);
  }
  return folders;
}

// 한 번에 PowerShell로 보내는 폴더 수. 시간 제한과 중간 보고의 단위다.
const FOLDER_BATCH = 100;

// 휴지통 일괄 이동의 결과를 사유로 바꾼다.
const FOLDER_STATUS_REASON = {
  moved: '검사 뒤에 경로가 바뀌었습니다(정션 등). 지우지 않았습니다.',
  notdir: '검사 뒤에 폴더가 아니게 됐습니다.',
  filled: '폴더에 파일이 생겨 지우지 않았습니다.',
  gone: '폴더가 이미 없습니다.',
  timeout: '시간 제한에 걸려 처리하지 못했습니다(오류 대화상자가 떴을 수 있습니다). 탐색기로 지워 보며 원인을 확인하세요.',
};

// 지우기 전에 Node에서 하는 검사. 통과하면 실제 경로를, 아니면 FcError를 낸다.
function checkFolder(folder, access, { dryRun }) {
  const real = access.delete(folder);
  // 안쪽을 가리키는 정션으로 바뀌었으면 다른 폴더를 지우게 된다.
  if (real !== folder) throw new FcError(`검사 뒤에 경로가 바뀌었습니다: ${folder} -> ${real}`);
  if (!dryRun) {
    if (!fs.lstatSync(real).isDirectory()) throw new FcError(`검사 뒤에 폴더가 아니게 됐습니다: ${real}`);
    const filled = walk(real).find((entry) => entry.type !== 'dir' && !isFolderMetadata(entry));
    if (filled) throw new FcError(`폴더에 파일이 생겨 지우지 않았습니다: ${filled.path}`);
    if (real.length > MAX_RECYCLE_PATH) throw new FcError(`경로가 ${real.length}자라 휴지통으로 보낼 수 없습니다(${MAX_RECYCLE_PATH}자까지): ${real}`);
    // 현재 폴더와 그 상위, 장치 이름 같은 rm의 검사를 지우지 않고(미리보기로) 그대로 거친다.
    remove([real], { dryRun: true });
  }
  return real;
}

// 빈 폴더를 휴지통으로 보낸다. 실패한 폴더는 kept에 남긴다. onFolder(folder, reason)는 폴더마다 끝나는 대로 불린다(reason이 없으면 보냄).
// 폴더마다 PowerShell을 띄우면 수천 개에서 몇 시간이 걸리므로 FOLDER_BATCH개씩 묶어 보낸다(#67). 묶음마다 Node에서 다시 검사하고,
// PowerShell도 폴더마다 지우기 직전에 실제 경로·폴더 여부·안의 파일을 다시 본다(recycleEmptyFolders).
// 휴지통이 없을 수 있는 드라이브(고정 디스크가 아닌 것)와 대화형이 아닌 세션에서는 영구 삭제될 수 있어 지우지 않는다.
function removeFolders(folders, access, { dryRun, onFolder = () => {} }) {
  const report = { removed: [], kept: [] };
  const done = (folder, reason) => {
    if (reason === undefined) report.removed.push(folder);
    else report.kept.push({ path: folder, reason });
    onFolder(folder, reason);
  };
  if (folders.length === 0) return report;
  // 미리보기도 실제 실행과 같은 사유로 남기도록 드라이브와 세션을 먼저 본다(1차 리뷰).
  const state = recycleBinState(access.target);
  let blocked;
  if (state.interactive === false) blocked = '대화형 세션이 아니면 휴지통으로 보낼 수 없습니다.';
  else if (state.driveType !== 'Fixed') blocked = `휴지통이 없어 영구 삭제될 수 있는 드라이브(${state.driveType ?? '종류를 알 수 없음'})라 빈 폴더를 지우지 않았습니다.`;
  const failure = (err) => (err instanceof FcError ? err.message : `휴지통으로 보낼 수 없습니다. (${err.code ?? err.status})`);
  if (dryRun) {
    for (const folder of folders) {
      if (blocked) {
        done(folder, blocked);
        continue;
      }
      try {
        remove([checkFolder(folder, access, { dryRun })], { dryRun });
        done(folder);
      } catch (err) {
        done(folder, failure(err));
      }
    }
    return report;
  }
  // 시간 제한에 걸린 묶음에서 손대지 않은 폴더(pending)는 다시 줄 세운다. 매번 하나 이상 끝나므로 언젠가 멈춘다.
  // 묶음의 첫 폴더에서 바로 시간 제한에 걸리는 일이 연속되면(폴더마다 대화상자가 뜨는 등) 폴더 하나씩만 끝나 몇 시간이 걸리므로 멈춘다(2차 리뷰).
  const MAX_STALLS = 2;
  let stalls = 0;
  const queue = [...folders];
  while (queue.length > 0) {
    const batch = [];
    for (const folder of queue.splice(0, FOLDER_BATCH)) {
      if (blocked) {
        done(folder, blocked);
        continue;
      }
      try {
        batch.push(checkFolder(folder, access, { dryRun }));
      } catch (err) {
        done(folder, failure(err));
      }
    }
    if (batch.length === 0) continue;
    let results;
    try {
      results = recycleEmptyFolders(batch, { allowedNames: FOLDER_METADATA_NAMES });
    } catch (err) {
      // 휴지통 호출의 실패 메시지에는 스크립트 전문이 들어가므로 쓰지 않는다.
      const reason = err instanceof FcError ? err.message : `휴지통으로 보내지 못했습니다. (${err.code ?? err.status})`;
      // 비대화형 세션, 잠금 환경처럼 묶음마다 똑같이 실패할 사유면 나머지도 보내지 않는다.
      if (err instanceof FcError) blocked = reason;
      for (const folder of batch) done(folder, reason);
      continue;
    }
    const pending = [];
    for (const { path: folder, status } of results) {
      if (status === 'pending') pending.push(folder);
      else if (status === 'ok' || (status === 'timeout' && !fs.existsSync(folder))) done(folder);
      else if (status === 'error') {
        // 폴더 안에 장치 이름 그대로인 항목이 있으면 휴지통 이동이 폴더째 실패한다(#135).
        const inside = bareDeviceInside(folder);
        done(folder, inside === undefined ? '휴지통으로 보내지 못했습니다.' : `휴지통으로 보내지 못했습니다. 안에 장치 이름 항목(${inside})이 있어 실패했을 수 있습니다. 그 항목을 fctl rename으로 바꾼 뒤 다시 지우세요.`);
      } else done(folder, FOLDER_STATUS_REASON[status]);
    }
    queue.unshift(...pending);
    if (results[0]?.status === 'timeout') stalls += 1;
    else stalls = 0;
    if (stalls >= MAX_STALLS) blocked = `묶음의 첫 폴더에서 시간 제한에 ${MAX_STALLS}번 연속 걸려 나머지 빈 폴더를 지우지 않았습니다(오류 대화상자가 떴을 수 있습니다). 원인을 확인한 뒤 다시 실행하세요.`;
  }
  return report;
}

// 타겟 아래 파일을 타겟 바로 아래로 옮기고, 비게 된 폴더를 휴지통으로 보낸다. 덮어쓰지 않고, 한 파일이 실패해도 나머지는 계속 옮긴다.
// 돌려주는 값: { target, dryRun, moved, stay, skipped, failed, removedFolders, keptFolders }.
// failed는 { from, reason }, keptFolders는 지우지 못한 폴더의 { path, reason } 목록이다.
// onProgress(line)를 주면 실제 실행에서 파일 하나, 폴더 하나가 끝날 때마다 보고 줄을 넘긴다. 중간에 끊겨도 이미 한 일을 알 수 있다(#67).
function flatten(dir, { dryRun = false, onProgress } = {}) {
  const plan = planFlatten(dir);
  const access = grant(plan.target, ['write', 'delete']);
  const result = { target: plan.target, dryRun, moved: [], stay: plan.stay, skipped: plan.skipped, failed: [], removedFolders: [], keptFolders: [] };
  if (dryRun) {
    const moving = new Set(plan.moves.map((move) => move.from));
    const after = walk(plan.target).filter((entry) => !moving.has(entry.path));
    const { removed, kept } = removeFolders(removableFolders(after, foldersOf(plan.moves, plan.target), plan.guarded), access, { dryRun });
    return { ...result, moved: plan.moves, removedFolders: removed, keptFolders: kept };
  }
  // 앞으로 옮길 파일의 이름을 뺏지 않도록 계획한 이름을 모두 차지한 것으로 본다.
  const taken = new Set(plan.moves.map((move) => nameKey(move.name)));
  const nextNumber = new Map();
  const relative = (p) => path.relative(plan.target, p) || '.';
  const report = (line) => onProgress?.(line);
  for (const move of plan.moves) {
    try {
      const moved = applyMove(move, access, taken, nextNumber);
      result.moved.push(moved);
      report(moveLine(moved, relative, ''));
    } catch (err) {
      result.failed.push({ from: move.from, reason: err.message });
      report(`실패: ${relative(move.from)} (${err.message})`);
    }
  }
  const onFolder = (folder, reason) => report(reason === undefined ? `빈 폴더를 휴지통으로: ${relative(folder)}` : `폴더 남김: ${relative(folder)} (${reason})`);
  // 계획이 아니라 이동이 끝난 실제 상태로 판단한다. 실패한 파일이나 그사이 생긴 파일이 있는 폴더는 남는다.
  try {
    const { removed, kept } = removeFolders(removableFolders(walk(plan.target), foldersOf(result.moved, plan.target), plan.guarded), access, { dryRun, onFolder });
    result.removedFolders = removed;
    result.keptFolders = kept;
  } catch (err) {
    result.keptFolders = [{ path: plan.target, reason: err.message }];
  }
  return result;
}

function moveLine(move, relative, prefix) {
  const notes = [move.fromFolder && '폴더명 사용', move.numbered && '번호 붙임'].filter(Boolean);
  return `${prefix}이동: ${relative(move.from)} -> ${move.name}${notes.length > 0 ? ` (${notes.join(', ')})` : ''}`;
}

// 결과를 사람이 읽을 수 있게 줄로 만든다. 자세한 보고 형식은 #19에서 다듬는다.
function formatFlatten(result) {
  const relative = (p) => path.relative(result.target, p) || '.';
  const prefix = result.dryRun ? '[미리보기] ' : '';
  const lines = [];
  for (const move of result.moved) lines.push(moveLine(move, relative, prefix));
  for (const item of result.skipped) lines.push(`${prefix}건너뜀: ${relative(item.path)} (${item.reason})`);
  for (const item of result.failed) lines.push(`실패: ${relative(item.from)} (${item.reason})`);
  for (const folder of result.removedFolders) lines.push(`${prefix}빈 폴더를 휴지통으로: ${relative(folder)}`);
  for (const item of result.keptFolders) lines.push(`${prefix}폴더 남김: ${relative(item.path)} (${item.reason})`);
  lines.push(`${prefix}이동 ${result.moved.length}개, 그대로 ${result.stay.length}개, 건너뜀 ${result.skipped.length}개, 실패 ${result.failed.length}개, 빈 폴더 제거 ${result.removedFolders.length}개`);
  return lines.join('\n');
}

module.exports = { withOuterFolder, FOLDER_METADATA, PROGRAM_FOLDER, PROJECT_FILE, planFlatten, detailedName, prefixedName, flatten, formatFlatten, MAX_NAME, LEFTOVER, SYSTEM_FOLDER, REPOSITORY_FOLDER, moveWithoutOverwrite, leftoverNote, rejectRepository, looksLikeGitDir };

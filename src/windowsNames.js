'use strict';

const os = require('node:os');
const path = require('node:path');

// 장치 이름(#53). Windows 11 빌드 26200에서 실측한 규칙: 장치 이름 그대로이거나 확장자가 하나만 붙은 이름(nul.mp4, con.txt, com².mp4)만
// PowerShell이 장치로 본다. 점이 둘 이상인 이름(Con.Air.1997.mkv, nul.tar.gz, COM¹.tar.gz), 점 앞에 공백이 있는 이름(Nul .mp4), COM0·LPT0은
// PowerShell, tar.exe, 휴지통 이동에서 모두 같은 파일로 다뤄진다. 휴지통 이동 스크립트가 Test-Path로 폴더인지 보므로 Test-Path 기준을 따른다.
// CONIN$·CONOUT$는 그 이름 그대로일 때만 거부한다.
// 좁은 규칙은 26200과 같은 기반인 24H2(빌드 26100, Server 2025 포함)부터 쓴다. 확인하지 못한 그 아래 버전에서 장치로 열리면
// 복사가 장치로 사라지고 드라이브 간 이동은 원본을 지우므로, 예전처럼 장치 이름으로 시작하는 이름을 모두 거부한다.
const WINDOWS_DEVICE_NAME_WIDE = /^(con|prn|aux|nul|com[\d¹²³]|lpt[\d¹²³]|conin\$|conout\$) *(\.|$)/i;
const WINDOWS_DEVICE_NAME_NARROW = /^((con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(\.[^.]*)?|conin\$|conout\$)$/i;
const NARROW_DEVICE_BUILD = 26100;

// 확장자 없는 장치 이름 그대로(nul, CON, Com1, lpt¹, CONIN$). Windows가 끝의 점과 공백을 지우므로 nul.·com1 도 같다(#135).
// 빌드 26200에서 tar.exe는 이런 이름을 인자로 받으면 장치를 열어 실패했고(nul, CON), 휴지통 이동도 실패했다
// (nul, CON, PRN, AUX, Com1, LPT9, lpt¹, COM², com1 , CONIN$, CONOUT$). COM0·LPT0은 파일이었다.
// 폴더 안에 든 이런 이름은 tar.exe가 파일로 묶고 푼다.
const BARE_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)[. ]*$/i;

// os.release()는 "10.0.26200"처럼 빌드 번호를 세 번째에 둔다. 읽지 못하면 넓은 규칙을 쓴다.
function deviceNamePattern(release = os.release()) {
  const build = Number(String(release).split('.')[2]);
  return Number.isInteger(build) && build >= NARROW_DEVICE_BUILD ? WINDOWS_DEVICE_NAME_NARROW : WINDOWS_DEVICE_NAME_WIDE;
}

const WINDOWS_DEVICE_NAME = deviceNamePattern();

// Windows는 이름 끝의 점과 공백을 지우고 연다. 그래서 com1 ·Nul.mp4.는 com1·Nul.mp4와 같은 장치다(#135).
// 스트림(nul:x)은 : 앞의 이름으로 파일을 만들므로 그 이름도 본다.
function isDeviceName(part, pattern = WINDOWS_DEVICE_NAME) {
  return [part, part.split(':')[0]].some((name) => pattern.test(name) || pattern.test(name.replace(/[. ]+$/, '')));
}

// 경로에서 장치 이름인 첫 이름(드라이브·UNC 뿌리는 빼고)을 돌려준다. 없거나 Windows가 아니면 undefined다.
function deviceNamePart(p, pattern = WINDOWS_DEVICE_NAME) {
  if (process.platform !== 'win32') return undefined;
  const full = path.resolve(p);
  return full.slice(path.parse(full).root.length).split(path.sep).find((part) => isDeviceName(part, pattern));
}

module.exports = { WINDOWS_DEVICE_NAME, BARE_DEVICE_NAME, deviceNamePattern, deviceNamePart, isDeviceName };

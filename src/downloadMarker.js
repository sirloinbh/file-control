'use strict';

const fs = require('node:fs');
const path = require('node:path');

// 받기 도구가 받는 중에 쓰는 이름의 꼬리. x.mp4를 받는 동안 x.mp4.part, x.mp4.aria2처럼 파일 이름 뒤에 붙는다.
// .part: Firefox, yt-dlp, JDownloader, Transmission / .crdownload: Chrome, Edge / .partial: 옛 Edge / .download: Safari / .opdownload: Opera
// .fdmdownload: Free Download Manager / .aria2: aria2 / .ytdl, .part-Frag숫자: yt-dlp / .td, .td.cfg, .xltd: Thunder(迅雷) / .!qB: qBittorrent / .!ut: µTorrent / .bc!: BitComet
// 받는 중인 내용 자체에 이 이름을 쓰는 도구가 많지만, 제 이름의 파일을 함께 두는 도구도 있다. aria2는 크기를 미리 잡은 x.mp4 옆에 x.mp4.aria2를,
// Firefox는 크기 0인 자리 파일 x.mp4 옆에 x.mp4.part를 둔다. 이런 x.mp4는 오래 멈춰 있으면 시각으로 알 수 없어 이 표시로만 알 수 있다.
const DOWNLOAD_MARKER = /^(.+?)\.(?:part(?:-frag\d+)?|crdownload|partial|download|opdownload|fdmdownload|aria2|ytdl|td(?:\.cfg)?|xltd|!qb|!ut|bc!)$/i;

// 폴더 안의 표시 파일을 받는 중인 파일 이름(소문자)으로 찾아볼 수 있게 모은다. Windows는 이름의 대소문자를 가리지 않는다.
function downloadMarkers(dir) {
  const markers = new Map();
  for (const name of fs.readdirSync(dir)) {
    const match = DOWNLOAD_MARKER.exec(name);
    if (match && !markers.has(match[1].toLowerCase())) markers.set(match[1].toLowerCase(), name);
  }
  return markers;
}

// 파일이 받는 중일 수 있다는 표시를 찾는 함수를 만든다. 폴더마다 표시 파일 목록을 한 번만 읽는다.
// 돌려주는 함수는 표시가 없으면 null을, 있으면 { folder } (Safari 표시 폴더 안), { marker } (옆의 표시 파일 이름),
// { error } (폴더를 읽지 못함, 오류 코드) 중 하나를 돌려준다. 읽지 못한 폴더도 기억해 그 폴더의 파일을 모두 표시가 있는 것으로 본다.
function markerFinder() {
  const markersIn = new Map();
  return (file) => {
    const dir = path.dirname(file);
    const name = path.basename(file).toLowerCase();
    // Safari는 받는 중인 파일을 x.mp4.download 폴더 안에 x.mp4로 둔다.
    if (path.basename(dir).toLowerCase() === `${name}.download`) return { folder: path.basename(dir) };
    if (!markersIn.has(dir)) {
      try {
        markersIn.set(dir, downloadMarkers(dir));
      } catch (err) {
        markersIn.set(dir, err);
      }
    }
    const markers = markersIn.get(dir);
    if (markers instanceof Error) return { error: markers.code ?? markers.message };
    const marker = markers.get(name);
    return marker === undefined ? null : { marker };
  };
}

// markerFinder가 찾은 표시를 남기는 사유로 쓴다. keeper를 주면 남길 파일의 표시로 적는다.
function markerReason(found, { keeper = false } = {}) {
  if (found === null) return null;
  if (found.folder !== undefined) return `${keeper ? '남길 파일이 ' : ''}받기 도구의 표시 폴더(${found.folder}) 안에 있어 아직 받는 중일 수 있어 남겼습니다.`;
  if (found.error !== undefined) return `받기 도구의 표시 파일을 확인하려고 ${keeper ? '남길 파일의 ' : ''}폴더를 읽지 못해 남겼습니다. (${found.error})`;
  return `받기 도구의 표시 파일(${found.marker})이 ${keeper ? '남길 파일 ' : ''}옆에 있어 아직 받는 중일 수 있어 남겼습니다. 받기를 그만뒀다면 표시 파일을 지운 뒤 다시 실행합니다.`;
}

module.exports = { DOWNLOAD_MARKER, downloadMarkers, markerFinder, markerReason };

'use strict';

// fctl ui: 로컬 웹 화면 서버(#251). node:http로 127.0.0.1에만 연결을 받는다(#250).
// 화면별 주소는 routes에 더한다(#254~#259). 이 파일은 서버 시작, 주소 찾기, 공통 응답(404, 405, 500)만 맡는다.

const http = require('node:http');
const { spawn } = require('node:child_process');
const { FcError } = require('../commands');
const { html } = require('./html');
const { CATEGORIES, page, table } = require('./layout');

const HOST = '127.0.0.1';
// project-standards의 포트 배정(슬롯 09, sirloinbh/project-standards#435).
const DEFAULT_PORT = 8109;

const UI_HELP = `사용법: fctl ui [--port=번호] [--no-open]

  로컬 웹 화면을 띄웁니다. 127.0.0.1에서만 접속할 수 있고 Ctrl+C로 끝냅니다.

옵션:
  --port=번호   받을 포트 (기본: ${DEFAULT_PORT}, 0이면 빈 포트)
  --no-open     기본 브라우저를 열지 않음
  -h, --help    도움말`;

function homePage(available) {
  const rows = CATEGORIES.map((category) => [
    available.has(category.path) ? html`<a href="${category.path}">${category.label}</a>` : html`${category.label} <span class="muted">(준비 중)</span>`,
    category.detail,
  ]);
  return page({
    title: '파일 컨트롤',
    available,
    body: html`<p>폴더와 파일을 다루는 fctl 명령을 화면에서 씁니다. 파일을 바꾸는 명령은 먼저 미리보기를 보여 주고, 지우기는 휴지통으로 보냅니다.</p>
${table([{ label: '분류', width: '30%' }, { label: '하는 일' }], rows)}`,
  });
}

// routes: Map<경로, (req, context) => { status?, body }>. context.available은 메뉴에 보일 경로 목록이다.
function createHandler(routes = new Map()) {
  const all = new Map([['/', () => ({ body: homePage(available) })], ...routes]);
  const available = new Set(all.keys());
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
    res.end(res.req.method === 'HEAD' ? undefined : body);
  };
  return (req, res) => {
    let pathname;
    try {
      pathname = new URL(req.url, `http://${HOST}`).pathname;
    } catch {
      pathname = null;
    }
    const route = pathname === null ? undefined : all.get(pathname);
    if (route === undefined) {
      send(res, 404, page({ title: '없는 화면', available, alerts: [{ kind: 'error', message: `없는 주소입니다: ${req.url}` }], body: html`<p><a href="/">처음 화면으로</a></p>` }));
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, page({ title: '허용하지 않는 요청', available, alerts: [{ kind: 'error', message: `이 주소는 ${req.method} 요청을 받지 않습니다.` }] }), { Allow: 'GET, HEAD' });
      return;
    }
    try {
      const result = route(req, { available });
      send(res, result.status ?? 200, result.body);
    } catch (err) {
      // 화면 코드의 예외는 스택 없이 문구만 보여 준다. 서버는 계속 돈다.
      send(res, 500, page({ title: '오류', available, alerts: [{ kind: 'error', message: err instanceof FcError ? err.message : `화면을 만들지 못했습니다: ${err.message}` }] }));
    }
  };
}

function parsePort(text) {
  if (!/^\d+$/.test(text) || Number(text) > 65535) throw new FcError(`--port에는 0~65535 사이 숫자를 쓰세요: ${text}`);
  return Number(text);
}

// fctl ui의 인자를 읽는다. 모르는 옵션이나 인자는 서버를 띄우기 전에 거부한다.
function parseUiArgs(argv) {
  const options = { port: DEFAULT_PORT, open: true, help: false };
  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg === '--no-open') options.open = false;
    else if (arg.startsWith('--port=')) options.port = parsePort(arg.slice('--port='.length));
    else if (arg === '--port') throw new FcError('--port에는 값을 --port=번호처럼 붙이세요.');
    else throw new FcError(`ui에서 알 수 없는 인자: ${arg}\n\n${UI_HELP}`);
  }
  return options;
}

// 서버를 띄우고 { server, url }을 돌려준다. 포트를 이미 쓰고 있으면 다른 포트로 넘어가지 않고 실패한다.
function startServer({ port = DEFAULT_PORT, routes } = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(createHandler(routes));
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(new FcError(`포트 ${port}를 이미 다른 프로그램이 쓰고 있습니다. 무엇이 쓰는지 확인하세요(netstat -ano | findstr :${port}). 다른 포트로 띄우려면 --port=번호를 쓰세요.`));
      } else if (err.code === 'EACCES') {
        reject(new FcError(`포트 ${port}를 열 권한이 없습니다. 다른 포트를 --port=번호로 고르세요.`));
      } else {
        reject(err);
      }
    });
    server.listen(port, HOST, () => {
      resolve({ server, url: `http://${HOST}:${server.address().port}/` });
    });
  });
}

// 기본 브라우저로 연다. 열지 못해도 주소는 이미 출력했으므로 서버는 계속 돈다.
function openBrowser(url) {
  if (process.platform !== 'win32') return;
  try {
    const child = spawn('cmd.exe', ['/d', '/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // 무시: 주소를 직접 열면 된다.
  }
}

// fctl ui 명령. out은 안내 줄을 쓰는 함수다.
async function runUi(argv, { out = (line) => console.log(line), routes } = {}) {
  const options = parseUiArgs(argv);
  if (options.help) {
    out(UI_HELP);
    return null;
  }
  const { server, url } = await startServer({ port: options.port, routes });
  out(`fctl 화면: ${url}`);
  out('끝내려면 Ctrl+C를 누르세요.');
  if (options.open) openBrowser(url);
  process.once('SIGINT', () => {
    server.close();
    server.closeAllConnections();
    out('화면 서버를 끝냈습니다.');
  });
  return server;
}

module.exports = { DEFAULT_PORT, HOST, UI_HELP, createHandler, parseUiArgs, startServer, runUi };

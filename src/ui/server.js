'use strict';

// fctl ui: 로컬 웹 화면 서버(#251). node:http로 127.0.0.1에만 연결을 받는다(#250).
// 화면별 주소는 routes에 더한다(#254~#259). 이 파일은 서버 시작, 주소 찾기, 공통 응답(404, 405, 500)만 맡는다.

const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { FcError } = require('../commands');
const { html, raw } = require('./html');
const { SECURITY_HEADERS, RequestError, createToken, checkRequest, readForm, tokenField } = require('./security');
const { CATEGORIES, page, table } = require('./layout');

const HOST = '127.0.0.1';
// project-standards의 포트 배정(슬롯 09, sirloinbh/project-standards#435).
const DEFAULT_PORT = 8109;

const UI_HELP = `Usage: fctl ui [--port=NUMBER] [--no-open]

  Starts the local web UI. It is reachable only at 127.0.0.1. Stop it with Ctrl+C.

Options:
  --port=NUMBER  port to listen on (default: ${DEFAULT_PORT}, 0 picks a free port)
  --no-open      do not open the default browser
  -h, --help     show help`;

function homePage(available) {
  const rows = CATEGORIES.map((category) => [
    available.has(category.path) ? html`<a href="${category.path}">${category.label}</a>` : html`${category.label} <span class="muted">(coming soon)</span>`,
    category.detail,
  ]);
  return page({
    title: 'File Control',
    available,
    body: html`<p>Use the fctl commands for folders and files from this page. Commands that change files show a preview first, and deletes go to the Recycle Bin.</p>
${table([{ label: 'Category', width: '30%' }, { label: 'What it does' }], rows)}`,
  });
}

// routes: Map<경로, 처리기 또는 { GET?, POST? }>. 함수 하나만 주면 GET 처리기다. HEAD는 GET 처리기로 답하고 본문만 뺀다.
// 처리기: (req, context) => { status?, body, headers? } 또는 그 Promise. body는 문자열이나 html``(SafeHtml)이다.
// context.available은 메뉴에 보일 경로 목록, context.tokenField는 숨은 토큰 필드(SafeHtml)다. tokenField는 method="post" 폼에만 넣는다.
// GET 폼이나 링크에 넣으면 토큰이 주소에 실려 브라우저 기록에 남는다(1차 리뷰).
// 요청 검사(#252): 모든 요청은 Host가 이 서버 주소여야 한다(DNS 재바인딩 방지). GET·HEAD가 아닌 요청은 Origin·폼 형식·본문 크기·토큰을
// 모두 확인한 뒤에만 처리기를 부르고, 읽은 폼 값을 context.form(URLSearchParams)으로 넘긴다. 파일을 바꾸는 처리기는 POST에만 둔다.
// token은 서버 시작 때 만든 무작위 값이다. 시험에서는 정해 줄 수 있다.
function createHandler(routes = new Map(), { token = createToken() } = {}) {
  const all = new Map([['/', () => ({ body: homePage(available) })], ...routes]);
  const available = new Set(all.keys());
  const send = (res, status, body, headers = {}) => {
    // 응답을 이미 시작했으면 다시 쓰지 않고 연결만 끊는다(예외 처리 중 ERR_HTTP_HEADERS_SENT로 서버가 죽지 않게).
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers, ...SECURITY_HEADERS });
    res.end(res.req.method === 'HEAD' ? undefined : String(body ?? ''));
  };
  const fail = (res, err) => {
    // 화면 코드의 예외는 스택 없이 문구만 보여 준다. 서버는 계속 돈다.
    send(res, 500, page({ title: 'Error', available, alerts: [{ kind: 'error', message: err instanceof FcError ? err.message : `Could not build the page: ${err.message}` }] }));
  };
  const context = { available, tokenField: raw(tokenField(token)) };
  return async (req, res) => {
    try {
      // 서버가 실제로 받는 포트로 Host를 본다. 빈 포트(0)로 띄워도 맞는 값이다.
      const port = req.socket.localPort;
      try {
        checkRequest(req, { port });
      } catch (err) {
        if (!(err instanceof RequestError)) throw err;
        send(res, err.status, page({ title: 'Request not accepted', available, alerts: [{ kind: 'error', message: err.message }] }));
        return;
      }
      let pathname;
      try {
        pathname = new URL(req.url, `http://${HOST}`).pathname;
      } catch {
        pathname = null;
      }
      const route = pathname === null ? undefined : all.get(pathname);
      if (route === undefined) {
        send(res, 404, page({ title: 'Page not found', available, alerts: [{ kind: 'error', message: `No such address: ${req.url}` }], body: html`<p><a href="/">Back to the start page</a></p>` }));
        return;
      }
      const methods = typeof route === 'function' ? { GET: route } : route;
      const handler = methods[req.method === 'HEAD' ? 'GET' : req.method];
      if (typeof handler !== 'function') {
        const allow = Object.keys(methods).flatMap((method) => (method === 'GET' ? ['GET', 'HEAD'] : [method])).join(', ');
        send(res, 405, page({ title: 'Request not allowed', available, alerts: [{ kind: 'error', message: `This address does not accept ${req.method} requests.` }] }), { Allow: allow });
        return;
      }
      let form;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        try {
          form = await readForm(req, { port, token });
        } catch (err) {
          if (!(err instanceof RequestError)) throw err;
          // 읽지 않은 본문이 남아 있으면 응답 뒤 연결을 닫아 다음 요청과 섞이지 않게 한다.
          res.setHeader('Connection', 'close');
          send(res, err.status, page({ title: 'Request not accepted', available, alerts: [{ kind: 'error', message: err.message }] }));
          return;
        }
      }
      const result = await handler(req, { ...context, form });
      send(res, result.status ?? 200, result.body, result.headers);
    } catch (err) {
      try {
        fail(res, err);
      } catch {
        res.destroy();
      }
    }
  };
}

// 다른 프로그램이 같은 포트를 모든 주소(0.0.0.0, ::)로 듣고 있으면 Windows는 127.0.0.1로 listen해도 성공시킨다(1차 리뷰 실측).
// 그러면 127.0.0.1로 오는 요청을 fctl이 가로채므로, 먼저 127.0.0.1:포트로 연결해 보아 받는 프로그램이 있으면 쓰는 중으로 본다.
// 모든 주소에 bind해 보는 방식은 방화벽 허용 창을 띄우고 잠깐 LAN에 포트를 열 수 있어 쓰지 않는다(2차 리뷰).
// 연결이 거부되거나(ECONNREFUSED) 2초 안에 답이 없으면 비어 있는 것으로 본다. 127.0.0.1에서 듣는 경우는 listen이 다시 잡는다.
function checkPortFree(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port, host: HOST });
    const done = (busy) => {
      socket.destroy();
      if (busy) reject(Object.assign(new Error(`Port ${port} is in use`), { code: 'EADDRINUSE' }));
      else resolve();
    };
    socket.setTimeout(2000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function parsePort(text) {
  if (!/^\d+$/.test(text) || Number(text) > 65535) throw new FcError(`Use a number from 0 to 65535 for --port: ${text}`);
  return Number(text);
}

// fctl ui의 인자를 읽는다. 모르는 옵션이나 인자는 서버를 띄우기 전에 거부한다.
function parseUiArgs(argv) {
  const options = { port: DEFAULT_PORT, open: true, help: false };
  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg === '--no-open') options.open = false;
    else if (arg.startsWith('--port=')) options.port = parsePort(arg.slice('--port='.length));
    else if (arg === '--port') throw new FcError('Attach the value to --port, like --port=NUMBER.');
    else throw new FcError(`Unknown argument for ui: ${arg}\n\n${UI_HELP}`);
  }
  return options;
}

// 서버를 띄우고 { server, url }을 돌려준다. 포트를 이미 쓰고 있으면 다른 포트로 넘어가지 않고 실패한다.
function startServer({ port = DEFAULT_PORT, routes } = {}) {
  const portError = (err) => {
    if (err.code === 'EADDRINUSE') return new FcError(`Port ${port} is already used by another program. Check what uses it (netstat -ano | findstr :${port}). To start on another port, use --port=NUMBER.`);
    if (err.code === 'EACCES') return new FcError(`No permission to open port ${port}. Choose another port with --port=NUMBER.`);
    return err;
  };
  // 빈 포트(0)는 운영체제가 고르므로 미리 볼 필요가 없다.
  const checked = port === 0 ? Promise.resolve() : checkPortFree(port);
  return checked.catch((err) => Promise.reject(portError(err))).then(() => new Promise((resolve, reject) => {
    const server = http.createServer(createHandler(routes));
    server.once('error', (err) => reject(portError(err)));
    server.listen({ port, host: HOST, exclusive: true }, () => {
      // 시작한 뒤의 서버 오류는 알리기만 하고 프로세스를 끝내지 않는다.
      server.on('error', (err) => console.error(`UI server error: ${err.message}`));
      resolve({ server, url: `http://${HOST}:${server.address().port}/` });
    });
  }));
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

function defaultRoutes() {
  const { createJobs } = require('./jobs');
  const { jobRoutes } = require('./jobPages');
  const { pickRoutes } = require('./pickPage');
  return new Map([...jobRoutes(createJobs()), ...pickRoutes()]);
}

// fctl ui 명령. out은 안내 줄을 쓰는 함수다.
async function runUi(argv, { out = (line) => console.log(line), routes } = {}) {
  const options = parseUiArgs(argv);
  if (options.help) {
    out(UI_HELP);
    return null;
  }
  // 화면별 주소를 따로 주지 않으면 작업 상태·결과 페이지(#253)를 붙인다. 명령은 자식 프로세스로 실행한다.
  const { server, url } = await startServer({ port: options.port, routes: routes ?? defaultRoutes() });
  out(`fctl UI: ${url}`);
  out('Press Ctrl+C to stop.');
  if (options.open) openBrowser(url);
  process.once('SIGINT', () => {
    server.close();
    server.closeAllConnections();
    out('UI server stopped.');
  });
  return server;
}

module.exports = { DEFAULT_PORT, HOST, UI_HELP, createHandler, parseUiArgs, startServer, runUi };

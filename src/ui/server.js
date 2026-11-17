'use strict';

// fctl ui: the local web screen server (#251). It accepts connections only on 127.0.0.1 with node:http (#250).
// Per-screen addresses are added to routes (#254 to #259). This file handles only server start, address lookup, and the common responses (404, 405, 500).

const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { FcError } = require('../commands');
const { html, raw } = require('./html');
const { SECURITY_HEADERS, RequestError, createToken, checkRequest, readForm, tokenField, sessionCookie, hasSession, isValidToken } = require('./security');
const { CATEGORIES, page, table } = require('./layout');

const HOST = '127.0.0.1';
// The port assignment of project-standards (slot 09, sirloinbh/project-standards#435).
const DEFAULT_PORT = 8109;

const UI_HELP = `Usage: fctl ui [--port=NUMBER] [--no-open]

  Starts the local web UI. It is reachable only at 127.0.0.1. Stop it with Ctrl+C.

Options:
  --port=NUMBER  port to listen on (default: ${DEFAULT_PORT}, 0 picks a free port)
  --no-open      do not open the default browser (open the printed address yourself)
  -h, --help     show help`;

// The page for a request without the session (#265). It carries no token, no file data, and no folder listing.
const NO_SESSION_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Open fctl from the terminal - fctl</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem}</style></head>
<body><h1>This page is not open to you</h1>
<p>Open the address printed in the terminal where <code>fctl ui</code> is running. It works once for the first browser that uses it.</p>
<p>If you restarted <code>fctl ui</code>, use the newly printed address.</p></body></html>`;

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

// routes: Map<path, handler or { GET?, POST? }>. If only one function is given, it is the GET handler. HEAD is answered with the GET handler, leaving out only the body.
// Handler: (req, context) => { status?, body, headers? } or a Promise of that. body is a string or html`` (SafeHtml).
// context.available is the list of paths shown in the menu, and context.tokenField is the hidden token field (SafeHtml). tokenField is put only in method="post" forms.
// Putting it in a GET form or link would carry the token in the address and leave it in the browser history (first review).
// Request check (#252): every request must have a Host that is this server's address (DNS rebinding prevention). For requests other than GET and HEAD, it checks Origin, the form type, the body size, and the token
// and calls the handler only after all of them, and passes the form values it read as context.form (URLSearchParams). A handler that changes files is placed only on POST.
// token is a random value made at server start. Tests can set it.
// Session (#265): launch is a one-time value made at server start. The first GET with ?launch=<value> gets the fctl_session cookie and a 303 to the same address without the query,
// and the value is used up. Every other request without that cookie gets 403 and the NO_SESSION_PAGE (checked after Host, before any route, so /job and /pick are covered too).
function createHandler(routes = new Map(), { token = createToken(), launch = createToken() } = {}) {
  let launchValue = launch;
  const session = createToken();
  const all = new Map([['/', () => ({ body: homePage(available) })], ...routes]);
  const available = new Set(all.keys());
  const send = (res, status, body, headers = {}) => {
    // If the response has already started, it does not write again and only drops the connection (so that the server does not die with ERR_HTTP_HEADERS_SENT during exception handling).
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers, ...SECURITY_HEADERS });
    res.end(res.req.method === 'HEAD' ? undefined : String(body ?? ''));
  };
  const fail = (res, err) => {
    // An exception in the screen code shows only the message, without a stack. The server keeps running.
    send(res, 500, page({ title: 'Error', available, alerts: [{ kind: 'error', message: err instanceof FcError ? err.message : `Could not build the page: ${err.message}` }] }));
  };
  const context = { available, tokenField: raw(tokenField(token)) };
  return async (req, res) => {
    try {
      // It looks at Host with the port the server really receives on. It is also correct when started with a free port (0).
      const port = req.socket.localPort;
      try {
        checkRequest(req, { port });
      } catch (err) {
        if (!(err instanceof RequestError)) throw err;
        send(res, err.status, page({ title: 'Request not accepted', available, alerts: [{ kind: 'error', message: err.message }] }));
        return;
      }
      let parsed = null;
      try {
        parsed = new URL(req.url, `http://${HOST}`);
      } catch {
        parsed = null;
      }
      const pathname = parsed === null ? null : parsed.pathname;
      const given = parsed === null ? [] : parsed.searchParams.getAll('launch');
      if (req.method === 'GET' && launchValue !== null && given.length === 1 && isValidToken(given[0], launchValue)) {
        launchValue = null;
        parsed.searchParams.delete('launch');
        // Leading slashes are collapsed so the Location can never become a protocol-relative address.
        send(res, 303, '', { Location: `/${parsed.pathname.replace(/^\/+/, '')}${parsed.search}`, 'Set-Cookie': sessionCookie(session) });
        return;
      }
      if (!hasSession(req.headers.cookie, session)) {
        send(res, 403, NO_SESSION_PAGE);
        return;
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
          // If an unread body remains, it closes the connection after the response so it does not mix with the next request.
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

// If another program listens on the same port on all addresses (0.0.0.0, ::), Windows makes listen on 127.0.0.1 succeed too (measured in the first review).
// Then fctl would intercept requests coming to 127.0.0.1, so it first tries connecting to 127.0.0.1:port, and if a program accepts, it is seen as in use.
// The approach of trying to bind on all addresses can bring up the firewall allow dialog and briefly open the port to the LAN, so it is not used (second review).
// If the connection is refused (ECONNREFUSED) or there is no answer within 2 seconds, it is seen as free. If something listens on 127.0.0.1, listen catches it again.
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

// It reads the arguments of fctl ui. Unknown options or arguments are refused before the server starts.
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

// It starts the server and returns { server, url, launchUrl }. If the port is already in use, it does not move to another port and fails.
function startServer({ port = DEFAULT_PORT, routes, token, launch = createToken() } = {}) {
  const portError = (err) => {
    if (err.code === 'EADDRINUSE') return new FcError(`Port ${port} is already used by another program. Check what uses it (netstat -ano | findstr :${port}). To start on another port, use --port=NUMBER.`);
    if (err.code === 'EACCES') return new FcError(`No permission to open port ${port}. Choose another port with --port=NUMBER.`);
    return err;
  };
  // A free port (0) is chosen by the operating system, so there is no need to check in advance.
  const checked = port === 0 ? Promise.resolve() : checkPortFree(port);
  return checked.catch((err) => Promise.reject(portError(err))).then(() => new Promise((resolve, reject) => {
    const server = http.createServer(createHandler(routes, { token, launch }));
    server.once('error', (err) => reject(portError(err)));
    server.listen({ port, host: HOST, exclusive: true }, () => {
      // A server error after it started is only reported and does not end the process.
      server.on('error', (err) => console.error(`UI server error: ${err.message}`));
      const url = `http://${HOST}:${server.address().port}/`;
      // launchUrl is the only way in (#265). url is the plain address that the browser is sent to after the launch step.
      resolve({ server, url, launchUrl: `${url}?launch=${encodeURIComponent(launch)}` });
    });
  }));
}

// It opens in the default browser. Even if it cannot open, the address was already printed, so the server keeps running.
function openBrowser(url) {
  if (process.platform !== 'win32') return;
  try {
    const child = spawn('cmd.exe', ['/d', '/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // Ignore: you can just open the address yourself.
  }
}

// The screens of each command category (#256 to #259). Each module exports { specs, views, routes(jobs) } (see src/ui/screens/).
const SCREENS = [
  require('./screens/archive'),
  require('./screens/cleanup'),
  require('./screens/files'),
];

function defaultRoutes() {
  const { createJobs } = require('./jobs');
  const { jobRoutes } = require('./jobPages');
  const { flowRoutes } = require('./flowPages');
  const { pickRoutes } = require('./pickPage');
  const jobs = createJobs();
  const specs = SCREENS.flatMap((screen) => screen.specs);
  const views = Object.assign({}, ...SCREENS.map((screen) => screen.views));
  return new Map([...jobRoutes(jobs, { specs, views }), ...flowRoutes(jobs, specs), ...SCREENS.flatMap((screen) => [...screen.routes(jobs)]), ...pickRoutes()]);
}

// The fctl ui command. out is a function that writes the guide lines.
async function runUi(argv, { out = (line) => console.log(line), routes } = {}) {
  const options = parseUiArgs(argv);
  if (options.help) {
    out(UI_HELP);
    return null;
  }
  // If per-screen addresses are not given separately, it attaches the job status and result pages (#253). The command runs in a child process.
  const { server, launchUrl } = await startServer({ port: options.port, routes: routes ?? defaultRoutes() });
  out(`fctl UI: ${launchUrl}`);
  out('Open this address in your browser. It works only once, for the first browser that uses it. After a restart, use the newly printed address.');
  out('Press Ctrl+C to stop.');
  if (options.open) openBrowser(launchUrl);
  process.once('SIGINT', () => {
    server.close();
    server.closeAllConnections();
    out('UI server stopped.');
  });
  return server;
}

module.exports = { DEFAULT_PORT, HOST, UI_HELP, createHandler, parseUiArgs, startServer, runUi };

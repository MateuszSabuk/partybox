// HTTP(S) + WebSocket entry point.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { WebSocketServer } from 'ws';
import { loadConfig, ROOT } from './config.js';
import { GameRegistry } from './games.js';
import { Hub } from './hub.js';
import { Sessions } from './sessions.js';

const log = {
  info: (...a) => console.log(new Date().toISOString().slice(11, 19), ...a),
  warn: (...a) => console.warn('WARN', ...a),
  error: (...a) => console.error('ERROR', ...a),
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.woff2': 'font/woff2',
};

const PROBES = new Set(['/generate_204', '/gen_204', '/hotspot-detect.html', '/library/test/success.html', '/connecttest.txt', '/ncsi.txt']);
const wifiEscape = (s) => String(s).replace(/([\\;,:"])/g, '\\$1');

export async function start(config = loadConfig()) {
  const sessions = new Sessions({
    dir: config.data.dir,
    persist: config.data.persistSessions,
    ttlMs: config.players.sessionTtlHours * 3600_000,
  });
  const games = new GameRegistry({ dir: config.games.dir, enabled: config.games.enabled, log });
  const hub = new Hub({ config, sessions, games, log });

  // ----- URLs & QR codes -----
  const tlsOn = !!(config.server.tls.enabled && fs.existsSync(config.server.tls.cert) && fs.existsSync(config.server.tls.key));
  if (config.server.tls.enabled && !tlsOn) log.warn('tls.enabled but cert/key not found – falling back to plain HTTP');
  const joinUrl = (() => {
    if (config.server.publicUrl) return config.server.publicUrl;
    const scheme = tlsOn ? 'https' : 'http';
    const port = tlsOn ? config.server.httpsPort : config.server.httpPort;
    const defPort = tlsOn ? 443 : 80;
    return `${scheme}://${config.server.domain || config.network.ip}${port === defPort ? '' : ':' + port}/`;
  })();
  const w = config.wifi;
  const wifiString = `WIFI:T:${w.password ? w.security : 'nopass'};S:${wifiEscape(w.ssid)};${w.password ? `P:${wifiEscape(w.password)};` : ''}${w.hidden ? 'H:true;' : ''};`;
  const qrOpts = { type: 'svg', margin: 1, errorCorrectionLevel: 'M' };
  const info = {
    ssid: w.ssid,
    password: w.password,
    joinUrl,
    wifiQr: await QRCode.toString(wifiString, qrOpts),
    joinQr: await QRCode.toString(joinUrl, qrOpts),
  };

  // ----- HTTP handler -----
  const publicDir = path.join(ROOT, 'public');

  function serveFile(req, res, file) {
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return notFound(res);
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] || 'application/octet-stream',
        'content-length': st.size,
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  }
  const notFound = (res) => (res.writeHead(404, { 'content-type': 'text/plain' }), res.end('Not found'));
  const json = (res, code, obj, extra = {}) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra });
    res.end(JSON.stringify(obj));
  };

  function handler(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = decodeURIComponent(url.pathname);

    // Optional: send phones to https. Never redirect (a) the Pi's own kiosk browser – it may not be able
    // to resolve the domain without internet – or (b) the OS connectivity probes, which must get
    // their plain-HTTP answer or phones show a "sign in to network" popup.
    if (tlsOn && config.server.tls.redirectHttp && !req.socket.encrypted && !PROBES.has(p) && !hub.isLocal(req.socket.remoteAddress)) {
      const host = (req.headers.host || '').replace(/:\d+$/, '');
      const port = config.server.httpsPort === 443 ? '' : ':' + config.server.httpsPort;
      res.writeHead(301, { location: `https://${config.server.domain || host}${port}${req.url}` });
      return res.end();
    }

    // Connectivity checks: if the Pi's DNS points these hosts at us, phones stop
    // complaining "no internet" and stay on the party Wi-Fi.
    if (p === '/generate_204' || p === '/gen_204') return (res.writeHead(204), res.end());
    if (p === '/hotspot-detect.html' || p === '/library/test/success.html')
      return (res.writeHead(200, { 'content-type': 'text/html' }), res.end('<HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>'));
    if (p === '/connecttest.txt') return (res.writeHead(200, { 'content-type': 'text/plain' }), res.end('Microsoft Connect Test'));
    if (p === '/ncsi.txt') return (res.writeHead(200, { 'content-type': 'text/plain' }), res.end('Microsoft NCSI'));

    if (p === '/api/info') return json(res, 200, info);

    if (p === '/api/join' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => {
        body += c;
        if (body.length > 1024) req.destroy();
      });
      req.on('end', () => {
        let name = '';
        try {
          name = JSON.parse(body).name;
        } catch {}
        const r = hub.join(name);
        if (r.error) return json(res, r.error === 'name' ? 400 : 409, r);
        const secure = req.socket.encrypted ? '; Secure' : '';
        json(res, 200, r, { 'set-cookie': `pb_token=${r.token}; Path=/; Max-Age=${config.players.sessionTtlHours * 3600}; SameSite=Lax${secure}` });
      });
      return;
    }

    // game client assets: /games/<id>/client/<file>
    const gm = /^\/games\/([a-z0-9-]+)\/client\/(.+)$/.exec(p);
    if (gm) {
      const file = games.clientFile(gm[1], gm[2]);
      return file ? serveFile(req, res, file) : notFound(res);
    }

    // shell
    if (p === '/') return serveFile(req, res, path.join(publicDir, 'index.html'));
    if (p === '/host') return serveFile(req, res, path.join(publicDir, 'host.html'));
    const file = path.normalize(path.join(publicDir, p));
    if (!file.startsWith(publicDir + path.sep)) return notFound(res);
    serveFile(req, res, file);
  }

  // ----- servers -----
  const wss = new WebSocketServer({ noServer: true, maxPayload: config.limits.maxMessageBytes, perMessageDeflate: false });
  const upgrade = (req, socket, head) => {
    if (new URL(req.url, 'http://x').pathname !== '/ws') return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => hub.accept(ws, req));
  };

  const servers = [];
  const listen = (srv, port) =>
    new Promise((resolve, reject) => {
      srv.on('upgrade', upgrade);
      srv.once('error', reject);
      srv.listen(port, config.server.host, () => resolve(srv.address().port));
    });

  const httpSrv = http.createServer(handler);
  const httpPort = await listen(httpSrv, config.server.httpPort);
  servers.push(httpSrv);
  let httpsPort = null;
  if (tlsOn) {
    const httpsSrv = https.createServer({ cert: fs.readFileSync(config.server.tls.cert), key: fs.readFileSync(config.server.tls.key) }, handler);
    httpsPort = await listen(httpsSrv, config.server.httpsPort);
    servers.push(httpsSrv);
  }

  log.info(`PartyBox up – http :${httpPort}${httpsPort ? `, https :${httpsPort}` : ''}`);
  log.info(`players join at  ${joinUrl}`);
  log.info(`host screen at   http://localhost:${httpPort}/host   (${games.list().length} game(s) found)`);

  const stop = async () => {
    hub.close();
    for (const ws of wss.clients) ws.terminate();
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  };
  return { hub, stop, httpPort, httpsPort, info, config };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = await start();
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => app.stop().then(() => process.exit(0)));
}

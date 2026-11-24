// End-to-end simulation: 12 phones + a host against a real server instance.
//   npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { defaults, ROOT } from '../src/config.js';
import { start } from '../src/server.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'partybox-'));
const config = structuredClone(defaults);
config.server.httpPort = 0;
config.data.dir = tmp;
config.games.dir = path.join(ROOT, 'games');
config.players.graceSeconds = 1;
config.games.config['tap-race'] = { countdownSeconds: 0.3, durationSeconds: 1, resultsSeconds: 0.5 };

const app = await start(config);
const base = `http://127.0.0.1:${app.httpPort}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = (cond, msg) => (assert.ok(cond, msg), console.log('  ✓', msg), passed++);

class Client {
  constructor(role, token) {
    this.role = role;
    this.token = token;
    this.msgs = [];
    this.state = null;
    this.game = [];
  }
  open() {
    return new Promise((resolve) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${app.httpPort}/ws`);
      this.ws.on('open', () => {
        this.ws.send(JSON.stringify({ t: 'hello', role: this.role, token: this.token }));
        resolve();
      });
      this.ws.on('message', (raw) => {
        const m = JSON.parse(raw);
        this.msgs.push(m);
        if (m.t === 'state') this.state = m;
        if (m.t === 'game') this.game.push(m);
      });
    });
  }
  send(m) {
    this.ws.send(JSON.stringify(m));
  }
  close() {
    this.ws.close();
  }
}

async function join(name) {
  const r = await fetch(base + '/api/join', { method: 'POST', body: JSON.stringify({ name }) });
  return { status: r.status, cookie: r.headers.get('set-cookie'), ...(await r.json()) };
}
async function waitFor(fn, ms = 4000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (fn()) return true;
    await sleep(20);
  }
  throw new Error('timeout waiting for: ' + fn.toString());
}

console.log('Setup');
const info = await (await fetch(base + '/api/info')).json();
ok(info.wifiQr.includes('<svg') && info.joinQr.includes('<svg'), 'Wi-Fi + join QR codes are generated');
ok((await fetch(base + '/generate_204')).status === 204, 'Android connectivity check answered');
ok((await fetch(base + '/games/tap-race/client/player.js')).status === 200, 'game client assets are served');
ok((await fetch(base + '/games/tap-race/client/..%2f..%2fserver.js')).status === 404, 'path traversal blocked');

const host = new Client('host');
await host.open();
await waitFor(() => host.state);
ok(host.state.games.some((g) => g.id === 'tap-race'), 'lobby lists the tap-race module automatically');

console.log('Joining 12 players');
const players = [];
for (let i = 1; i <= 12; i++) {
  const j = await join('Player' + i);
  assert.equal(j.status, 200);
  if (i === 1) ok(/pb_token=[0-9a-f]{32}/.test(j.cookie) && j.cookie.includes(j.token), 'join sets the pb_token cookie (same token as returned)');
  const c = new Client('player', j.token);
  c.id = j.id;
  await c.open();
  players.push(c);
}
const firstJoin = await join('CookieCheck-full'); // party is full, so this must NOT issue a cookie
ok(firstJoin.status === 409 && !firstJoin.cookie, 'no token/cookie is issued when the party is full');
const thirteenth = await join('Late');
ok(thirteenth.status === 409 && thirteenth.error === 'full', 'player #13 is rejected (max 12)');
await waitFor(() => host.state.players.filter((p) => p.on).length === 12);
ok(true, 'host sees 12 connected players');

console.log('Lobby control');
const [leader, other] = players;
ok(host.state.leader === leader.id, 'first player is the leader');
other.send({ t: 'lobby:select', game: 'tap-race' });
await sleep(100);
ok(host.state.selected === null, 'non-leader cannot pick a game');
leader.send({ t: 'lobby:select', game: 'tap-race' });
await waitFor(() => host.state.selected === 'tap-race');
ok(host.state.canStart, 'leader picked tap-race, canStart = true');
leader.send({ t: 'lobby:start' });
await waitFor(() => host.state.phase === 'game');
await waitFor(() => players.every((p) => p.state?.phase === 'game' && p.state.active?.id === 'tap-race'));
ok(true, 'all 12 phones switched to the game phase');
await waitFor(() => players.every((p) => p.game.some((g) => g.snap)));
ok(true, 'every phone received a game snapshot on start');
ok(host.game.some((g) => g.snap), 'host received a game snapshot');

console.log('Playing + reconnect mid-game');
await waitFor(() => players[3].game.some((g) => g.d?.type === 'phase' && g.d.phase === 'play'));
for (const p of players) p.send({ t: 'game', d: { type: 'tap', n: 5 } });
for (const p of players) p.send({ t: 'game', d: { type: 'tap', n: 99 } }); // cheat attempt, clamped to 8
await sleep(150);

const victim = players[5];
const token = victim.token;
victim.close();
await waitFor(() => host.state.players.find((p) => p.id === victim.id && !p.on));
ok(true, 'host marks dropped player as reconnecting');

const back = new Client('player', token); // same token, brand new socket = phone coming back
back.id = victim.id;
await back.open();
await waitFor(() => back.game.some((g) => g.snap));
const snap = back.game.find((g) => g.snap).d;
ok(snap.taps === 13 && snap.phase === 'play', `reconnected player resumes with taps preserved (${snap.taps}) – clamp worked`);
ok(back.msgs.find((m) => m.t === 'welcome').you.id === victim.id, 'same player identity after reconnect');
players[5] = back;
await waitFor(() => host.state.players.find((p) => p.id === victim.id)?.on);

console.log('Results + back to lobby');
await waitFor(() => host.state.phase === 'lobby' && host.state.last, 6000);
ok(host.state.last.game === 'Tap Race', 'game ended and returned everyone to the lobby');
const total = host.state.players.reduce((s, p) => s + p.score, 0);
ok(total > 0, `scores carried into the lobby (sum ${total}) – same tokens, same players`);
ok(host.state.players.length === 12, 'all 12 sessions survived the game switch');

console.log('Avatars + colours');
const fx = (n) => fs.readFileSync(path.join(ROOT, 'test/fixtures', n));
const up = (token, body, headers = {}) => fetch(base + '/api/avatar', { method: 'POST', headers: { 'x-pb-token': token, 'content-type': 'image/jpeg', ...headers }, body });
const hues = host.state.players.map((p) => p.color);
const hueGap = Math.min(...hues.flatMap((a, i) => hues.slice(i + 1).map((b) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b)))));
ok(host.state.players.every((p) => Number.isInteger(p.color) && p.av === 0), 'everyone starts with a personal colour and no photo (silhouette)');
ok(hueGap >= 12, `12 players get clearly different colours (closest pair ${hueGap} degrees apart)`);

const who = players[1];
ok((await up('', fx('photo.jpg'))).status === 401, 'upload without a token is refused (401)');
ok((await up('f'.repeat(32), fx('photo.jpg'))).status === 401, 'upload with an unknown token is refused (401)');
ok((await up(who.token, fx('photo.png'), { 'content-type': 'image/png' })).status === 415, 'PNG / non-JPEG upload refused (415)');
ok((await up(who.token, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(70_000, 1)]))).status === 413, 'upload over 64 KB refused (413)');
ok((await up(who.token, fx('huge-dims.jpg'))).status === 422, '1000x1000 JPEG refused (422) – no decompression bombs');
ok((await up(who.token, Buffer.from('<script>alert(1)</script>'))).status === 415, 'garbage bytes refused (415)');
ok((await up(who.token, fx('photo.jpg'))).status === 200, 'valid framed photo accepted');
await waitFor(() => host.state.players.find((p) => p.id === who.id).av === 1);
ok(true, 'host + phones are told the new avatar version (av=1) via the normal state broadcast');
const img = await fetch(`${base}/avatar/${who.id}.jpg?v=1`);
ok(img.status === 200 && img.headers.get('content-type') === 'image/jpeg' && img.headers.get('x-content-type-options') === 'nosniff', 'avatar is served as image/jpeg with nosniff');
ok(Buffer.compare(Buffer.from(await img.arrayBuffer()), fx('photo.jpg')) === 0, 'served bytes are exactly the uploaded photo');
ok(fs.existsSync(path.join(tmp, 'avatars', who.id + '.jpg')), 'avatar stored on disk (survives restart)');
ok((await up(who.token, fx('photo.jpg'))).status === 429, 'second upload within 1 s is rate-limited (429)');
await sleep(1100);
ok((await up(who.token, fx('photo.jpg'))).status === 200, 'photo can be changed again at any time');
await waitFor(() => host.state.players.find((p) => p.id === who.id).av === 2);
ok(true, 'avatar version bumped to 2 (cache-buster for the new image)');
ok((await fetch(`${base}/avatar/p999.jpg`)).status === 404 && (await fetch(`${base}/avatar/..%2fsessions.json`)).status === 404, 'unknown id / traversal on /avatar -> 404');
const del = await fetch(base + '/api/avatar', { method: 'DELETE', headers: { 'x-pb-token': who.token } });
await waitFor(() => host.state.players.find((p) => p.id === who.id).av === 0);
ok(del.status === 200 && (await fetch(`${base}/avatar/${who.id}.jpg`)).status === 404, 'removing the photo returns to the silhouette and deletes the file');
// a cookie alone also authenticates (phone that lost localStorage)
await sleep(1100); // (the 1 s rate limit applies per player, including to this request)
const viaCookie = await fetch(base + '/api/avatar', { method: 'POST', headers: { cookie: 'pb_token=' + who.token, 'content-type': 'image/jpeg' }, body: fx('photo.jpg') });
ok(viaCookie.status === 200, `upload authenticates via the pb_token cookie too (status ${viaCookie.status})`);
await waitFor(() => host.state.players.find((p) => p.id === who.id).av === 1);

console.log('Persistence');
app.hub.sessions.saveNow();
const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'sessions.json'), 'utf8'));
ok(saved.players.length === 12 && saved.players.every((p) => p.token.length === 32), 'sessions persisted to disk (survive Pi restart)');
ok(saved.players.every((p) => Number.isInteger(p.color)) && saved.players.find((p) => p.id === who.id).av === 1, 'colours and avatar versions persisted too');

console.log('Cleanup');
const victim2 = players[11];
ok((await up(victim2.token, fx('photo.jpg'))).status === 200, 'player #12 uploads a photo');
const f12 = path.join(tmp, 'avatars', victim2.id + '.jpg');
ok(fs.existsSync(f12), 'file exists before kick');
host.send({ t: 'lobby:kick', id: victim2.id });
await waitFor(() => !fs.existsSync(f12));
ok((await fetch(`${base}/avatar/${victim2.id}.jpg`)).status === 404, 'kicking a player deletes their avatar file');

console.log('Unknown token');
const stranger = new Client('player', 'f'.repeat(32));
await stranger.open();
await waitFor(() => stranger.msgs.some((m) => m.t === 'need-join'));
ok(true, 'unknown/expired token is told to join again');

for (const p of players) p.close();
host.close();
stranger.close();
await app.stop();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} checks passed`);
process.exit(0);

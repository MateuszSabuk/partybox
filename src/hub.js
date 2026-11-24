// The hub: one WebSocket protocol for lobby + games, one session token for everything.
//
// Wire protocol (JSON, short keys on purpose):
//   client -> server
//     {t:'hello', role:'player', token}            first message from a phone
//     {t:'hello', role:'host', pin?}               first message from the TV screen
//     {t:'ping', c}                                 -> {t:'pong', c}
//     {t:'lobby:select', game} {t:'lobby:start'} {t:'lobby:stop'}
//     {t:'lobby:rename', name} {t:'lobby:kick', id} {t:'lobby:reset'}
//     {t:'game', d}                                 opaque payload for the active game
//   server -> client
//     {t:'welcome', you, hb}  {t:'need-join'}  {t:'state', ...}  {t:'game', d, snap?}
import os from 'node:os';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);

export class Hub {
  constructor({ config, sessions, games, log }) {
    this.cfg = config;
    this.sessions = sessions;
    this.games = games;
    this.log = log;
    this.host = null; // current host socket
    this.sockets = new Set();
    this.phase = 'lobby'; // 'lobby' | 'game'
    this.selected = null;
    this.active = null; // { id, name, instance, timers:Set }
    this.lastResult = null;
    this.localAddrs = new Set(
      Object.values(os.networkInterfaces()).flat().filter(Boolean).map((i) => i.address),
    );

    this.heartbeat = setInterval(() => this.beat(), config.players.heartbeatSeconds * 1000);
    this.purge = setInterval(() => this.sessions.purgeExpired(), 60_000);
  }

  close() {
    clearInterval(this.heartbeat);
    clearInterval(this.purge);
    this.stopGame(false);
    this.sessions.saveNow();
  }

  // ---------- helpers ----------
  isLocal(addr) {
    return LOOPBACK.has(addr) || this.localAddrs.has(addr?.replace('::ffff:', ''));
  }

  send(ws, msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  toPlayers(msg) {
    const raw = JSON.stringify(msg);
    for (const p of this.sessions.all()) if (p.ws?.readyState === 1) p.ws.send(raw);
  }

  toHost(msg) {
    this.send(this.host, msg);
  }

  publicPlayer(p) {
    return { id: p.id, name: p.name, score: p.score, on: p.connected, away: p.away, color: p.color, av: p.av };
  }

  // ---------- avatars (called by the HTTP layer) ----------
  /** @returns {{ok:true}|{error:string}} */
  setAvatar(token, buf) {
    const p = this.sessions.getByToken(token);
    if (!p) return { error: 'auth' };
    if (Date.now() - p.lastAvatarAt < 1000) return { error: 'rate' };
    this.sessions.setAvatar(p, buf);
    this.broadcastState();
    return { ok: true };
  }

  clearAvatar(token) {
    const p = this.sessions.getByToken(token);
    if (!p) return { error: 'auth' };
    this.sessions.clearAvatar(p);
    this.broadcastState();
    return { ok: true };
  }

  leaderId() {
    const all = this.sessions.all();
    return (all.find((p) => p.connected) || all[0])?.id ?? null;
  }

  stateMsg() {
    const players = this.sessions.all();
    const sel = this.selected && this.games.get(this.selected);
    const connected = players.filter((p) => p.connected).length;
    return {
      t: 'state',
      phase: this.phase,
      selected: sel ? sel.id : null,
      games: this.games.list(),
      players: players.map((p) => this.publicPlayer(p)),
      leader: this.cfg.lobby.leaderCanControl ? this.leaderId() : null,
      active: this.active ? { id: this.active.id, name: this.active.name } : null,
      canStart: !!sel && connected >= sel.minPlayers && (!sel.maxPlayers || connected <= sel.maxPlayers),
      last: this.lastResult,
      max: this.cfg.players.max,
    };
  }

  broadcastState() {
    const msg = this.stateMsg();
    this.toPlayers(msg);
    this.toHost(msg);
  }

  // ---------- connections ----------
  accept(ws, req) {
    this.sockets.add(ws);
    ws.isAlive = true;
    ws.meta = { role: null, player: null, addr: req.socket.remoteAddress, bucket: this.cfg.limits.messagesPerSecond, ts: Date.now() };
    ws.cookieToken = /(?:^|;\s*)pb_token=([0-9a-f]{32})/.exec(req.headers.cookie || '')?.[1] || null;

    const helloTimer = setTimeout(() => ws.meta.role || ws.close(4002, 'hello timeout'), 5000);
    ws.on('pong', () => (ws.isAlive = true));
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      ws.isAlive = true;
      if (!this.allow(ws)) return;
      let m;
      try {
        m = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!m || typeof m.t !== 'string') return;
      try {
        this.onMessage(ws, m);
      } catch (e) {
        this.log.error('handler error', e);
      }
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      this.sockets.delete(ws);
      this.onClose(ws);
    });
    ws.on('error', () => {});
  }

  allow(ws) {
    const m = ws.meta;
    const now = Date.now();
    m.bucket = Math.min(this.cfg.limits.messagesPerSecond, m.bucket + ((now - m.ts) / 1000) * this.cfg.limits.messagesPerSecond);
    m.ts = now;
    if (m.bucket < 1) return false;
    m.bucket -= 1;
    return true;
  }

  beat() {
    for (const ws of this.sockets) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {}
    }
  }

  onMessage(ws, m) {
    if (m.t === 'ping') return this.send(ws, { t: 'pong', c: m.c });
    if (!ws.meta.role) return m.t === 'hello' ? this.hello(ws, m) : undefined;

    if (ws.meta.role === 'host') return this.hostMessage(ws, m);
    return this.playerMessage(ws, ws.meta.player, m);
  }

  hello(ws, m) {
    if (m.role === 'host') {
      const pin = this.cfg.lobby.hostPin;
      if (!this.isLocal(ws.meta.addr) && !(pin && m.pin === pin)) {
        this.send(ws, { t: 'denied', why: 'host-pin' });
        return ws.close(4003, 'host denied');
      }
      if (this.host && this.host !== ws) this.host.close(4000, 'replaced');
      ws.meta.role = 'host';
      this.host = ws;
      this.games.list(true); // pick up freshly added game folders
      this.send(ws, { t: 'welcome', role: 'host', hb: this.cfg.players.heartbeatSeconds });
      this.send(ws, this.stateMsg());
      if (this.active) this.sendHostSnapshot();
      return;
    }

    const p = this.sessions.getByToken(m.token) || this.sessions.getByToken(ws.cookieToken);
    if (!p) return this.send(ws, { t: 'need-join' });

    // same player opened a second tab/phone: newest wins, old one is told not to fight back
    if (p.ws && p.ws !== ws) p.ws.close(4000, 'replaced');
    clearTimeout(p.graceTimer);
    p.ws = ws;
    p.connected = true;
    p.away = false;
    p.lastSeen = Date.now();
    ws.meta.role = 'player';
    ws.meta.player = p;
    this.send(ws, { t: 'welcome', role: 'player', you: { id: p.id, name: p.name }, hb: this.cfg.players.heartbeatSeconds });
    this.send(ws, this.stateMsg());
    if (this.active) {
      this.send(ws, { t: 'game', snap: true, d: this.safe(() => this.active.instance.snapshot?.(this.publicPlayer(p))) });
      this.safe(() => this.active.instance.onPlayerReconnect?.(this.publicPlayer(p)));
    }
    this.broadcastState();
  }

  onClose(ws) {
    if (ws === this.host) {
      this.host = null;
      return;
    }
    const p = ws.meta.player;
    if (!p || p.ws !== ws) return; // replaced by a newer socket
    p.ws = null;
    p.connected = false;
    p.lastSeen = Date.now();
    this.sessions.save();
    this.safe(() => this.active?.instance.onPlayerDisconnect?.(this.publicPlayer(p)));
    p.graceTimer = setTimeout(() => {
      p.away = true;
      this.safe(() => this.active?.instance.onPlayerAway?.(this.publicPlayer(p)));
      this.broadcastState();
    }, this.cfg.players.graceSeconds * 1000);
    this.broadcastState();
  }

  // ---------- joining (called by HTTP /api/join) ----------
  join(rawName) {
    const name = clean(rawName, this.cfg.players.nameMaxLength);
    if (name.length < 1) return { error: 'name' };
    if (this.sessions.all().length >= this.cfg.players.max) return { error: 'full' };
    if (this.phase === 'game' && !this.cfg.lobby.allowJoinDuringGame) return { error: 'running' };
    const p = this.sessions.create(name);
    this.broadcastState();
    if (this.active) this.safe(() => this.active.instance.onPlayerJoin?.(this.publicPlayer(p)));
    return { token: p.token, id: p.id, name: p.name };
  }

  // ---------- messages ----------
  canControl(ws) {
    if (ws.meta.role === 'host') return true;
    return this.cfg.lobby.leaderCanControl && ws.meta.player?.id === this.leaderId();
  }

  hostMessage(ws, m) {
    if (m.t === 'game') return this.safe(() => this.active?.instance.onHostMessage?.(m.d));
    this.control(ws, m);
  }

  playerMessage(ws, p, m) {
    p.lastSeen = Date.now();
    if (m.t === 'game') {
      if (!this.active) return;
      return this.safe(() => this.active.instance.onMessage?.(this.publicPlayer(p), m.d));
    }
    if (m.t === 'lobby:rename') {
      const name = clean(m.name, this.cfg.players.nameMaxLength);
      if (name) {
        p.name = name;
        this.sessions.save();
        this.broadcastState();
      }
      return;
    }
    this.control(ws, m);
  }

  control(ws, m) {
    if (!m.t.startsWith('lobby:') || !this.canControl(ws)) return;
    switch (m.t) {
      case 'lobby:select':
        if (this.phase === 'lobby' && this.games.get(m.game)) {
          this.selected = m.game;
          this.broadcastState();
        }
        break;
      case 'lobby:start':
        this.startGame();
        break;
      case 'lobby:stop':
        this.stopGame(true);
        break;
      case 'lobby:kick': {
        const p = this.sessions.getById(m.id);
        if (p) {
          p.ws?.close(4001, 'kicked');
          this.sessions.remove(p.id);
          this.broadcastState();
        }
        break;
      }
      case 'lobby:reset':
        if (ws.meta.role === 'host') {
          this.stopGame(false);
          this.sessions.clear();
          this.lastResult = null;
          this.selected = null;
          for (const s of this.sockets) if (s.meta.role === 'player') s.close(4001, 'reset');
          this.broadcastState();
        }
        break;
    }
  }

  // ---------- game lifecycle ----------
  async startGame() {
    if (this.phase !== 'lobby' || this.starting) return;
    const state = this.stateMsg();
    if (!state.canStart) return;
    const manifest = this.games.get(this.selected);
    this.starting = true;
    try {
      const timers = new Set();
      const hub = this;
      const ctx = {
        config: this.cfg.games.config[manifest.id] || {},
        players: () => hub.sessions.all().map((p) => hub.publicPlayer(p)),
        send: (id, d) => hub.send(hub.sessions.getById(id)?.ws, { t: 'game', d }),
        sendAll: (d) => hub.toPlayers({ t: 'game', d }),
        sendHost: (d) => hub.toHost({ t: 'game', d }),
        setTimeout: (fn, ms) => {
          const h = setTimeout(() => (timers.delete(h), hub.safe(fn)), ms);
          timers.add(h);
          return h;
        },
        setInterval: (fn, ms) => {
          const h = setInterval(() => hub.safe(fn), ms);
          timers.add(h);
          return h;
        },
        clear: (h) => (clearTimeout(h), clearInterval(h), timers.delete(h)),
        // Game is over: add points {playerId: n}, optionally attach a summary, return to the lobby.
        endGame: (points = {}, summary = null) => hub.finishGame(manifest, points, summary),
        log: (...a) => hub.log.info(`[${manifest.id}]`, ...a),
      };
      const instance = await this.games.instantiate(manifest.id, ctx);
      this.active = { id: manifest.id, name: manifest.name, instance, timers };
      this.phase = 'game';
      this.lastResult = null;
      this.broadcastState();
      for (const p of this.sessions.all()) {
        if (p.connected) this.send(p.ws, { t: 'game', snap: true, d: this.safe(() => instance.snapshot?.(this.publicPlayer(p))) });
      }
      this.sendHostSnapshot();
      this.safe(() => instance.start?.());
      this.log.info(`game started: ${manifest.id}`);
    } catch (e) {
      this.log.error(`could not start ${this.selected}:`, e);
      this.stopGame(true);
    } finally {
      this.starting = false;
    }
  }

  sendHostSnapshot() {
    if (this.active) this.toHost({ t: 'game', snap: true, d: this.safe(() => this.active.instance.hostSnapshot?.()) });
  }

  finishGame(manifest, points, summary) {
    if (!this.active || this.active.id !== manifest.id) return;
    for (const [id, pts] of Object.entries(points)) {
      const p = this.sessions.getById(id);
      if (p && Number.isFinite(pts)) p.score += Math.round(pts);
    }
    this.sessions.save();
    this.lastResult = { game: manifest.name, points, summary };
    this.stopGame(true);
  }

  stopGame(broadcast) {
    if (this.active) {
      this.safe(() => this.active.instance.destroy?.());
      for (const h of this.active.timers) (clearTimeout(h), clearInterval(h));
      this.active = null;
    }
    this.phase = 'lobby';
    if (broadcast) this.broadcastState();
  }

  safe(fn) {
    try {
      return fn();
    } catch (e) {
      this.log.error('game module error', e);
      return undefined;
    }
  }
}

// Player sessions. ONE token identifies a player in the lobby AND in every game,
// so switching games never asks anyone to log in again.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export class Sessions {
  constructor({ dir, persist, ttlMs }) {
    this.byToken = new Map();
    this.byId = new Map();
    this.ttlMs = ttlMs;
    this.file = persist ? path.join(dir, 'sessions.json') : null;
    this.nextId = 1;
    this.saveTimer = null;
    if (this.file) fs.mkdirSync(dir, { recursive: true });
    this.load();
  }

  load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const now = Date.now();
      for (const p of raw.players || []) {
        if (now - p.lastSeen > this.ttlMs) continue;
        this.add({ ...p, connected: false, away: true, ws: null, graceTimer: null });
      }
      this.nextId = Math.max(this.nextId, raw.nextId || 1);
    } catch (e) {
      console.warn('[sessions] could not load, starting fresh:', e.message);
    }
  }

  add(p) {
    this.byToken.set(p.token, p);
    this.byId.set(p.id, p);
    const n = Number(String(p.id).slice(1));
    if (n >= this.nextId) this.nextId = n + 1;
    return p;
  }

  create(name) {
    const p = {
      id: 'p' + this.nextId++,
      token: crypto.randomBytes(16).toString('hex'),
      name,
      score: 0,
      joinedAt: Date.now(),
      lastSeen: Date.now(),
      connected: false,
      away: false,
      ws: null,
      graceTimer: null,
    };
    this.add(p);
    this.save();
    return p;
  }

  getByToken(token) {
    if (typeof token !== 'string' || token.length !== 32) return null;
    return this.byToken.get(token) || null;
  }

  getById(id) {
    return this.byId.get(id) || null;
  }

  all() {
    return [...this.byId.values()].sort((a, b) => a.joinedAt - b.joinedAt);
  }

  remove(id) {
    const p = this.byId.get(id);
    if (!p) return;
    clearTimeout(p.graceTimer);
    this.byId.delete(id);
    this.byToken.delete(p.token);
    this.save();
  }

  clear() {
    for (const p of this.all()) this.remove(p.id);
  }

  purgeExpired() {
    const now = Date.now();
    for (const p of this.all()) {
      if (!p.connected && now - p.lastSeen > this.ttlMs) this.remove(p.id);
    }
  }

  save() {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveNow();
    }, 500);
  }

  saveNow() {
    if (!this.file) return;
    const players = this.all().map(({ ws, graceTimer, connected, away, ...rest }) => rest);
    const tmp = this.file + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify({ nextId: this.nextId, players }));
      fs.renameSync(tmp, this.file); // atomic: a power cut can't leave half a file
    } catch (e) {
      console.warn('[sessions] save failed:', e.message);
    }
  }
}

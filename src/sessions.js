// Player sessions. ONE token identifies a player in the lobby AND in every game,
// so switching games never asks anyone to log in again.
// A session also owns the player's look: a personal colour (hue) and an optional framed photo.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export class Sessions {
  constructor({ dir, persist, ttlMs }) {
    this.byToken = new Map();
    this.byId = new Map();
    this.ttlMs = ttlMs;
    this.dir = dir;
    this.file = persist ? path.join(dir, 'sessions.json') : null;
    this.avatarDir = path.join(dir, 'avatars');
    this.nextId = 1;
    this.saveTimer = null;
    this.hueBase = Math.random() * 360; // random start, then golden-angle steps -> neighbours never look alike
    fs.mkdirSync(this.avatarDir, { recursive: true });
    this.load();
  }

  load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const now = Date.now();
      for (const p of raw.players || []) {
        if (now - p.lastSeen > this.ttlMs) continue;
        const hasFile = p.av > 0 && fs.existsSync(this.avatarPath(p.id));
        this.add({ color: this.hueFor(p.id), ...p, av: hasFile ? p.av : 0, connected: false, away: true, ws: null, graceTimer: null, lastAvatarAt: 0 });
      }
      this.nextId = Math.max(this.nextId, raw.nextId || 1);
      if (raw.hueBase !== undefined) this.hueBase = raw.hueBase;
    } catch (e) {
      console.warn('[sessions] could not load, starting fresh:', e.message);
    }
  }

  hueFor(id) {
    return Math.round((this.hueBase + Number(String(id).slice(1)) * 137.508) % 360);
  }

  add(p) {
    this.byToken.set(p.token, p);
    this.byId.set(p.id, p);
    const n = Number(String(p.id).slice(1));
    if (n >= this.nextId) this.nextId = n + 1;
    return p;
  }

  create(name) {
    const id = 'p' + this.nextId++;
    const p = {
      id,
      token: crypto.randomBytes(16).toString('hex'),
      name,
      score: 0,
      color: this.hueFor(id),
      av: 0, // avatar version: 0 = none (silhouette), n = photo revision (cache-buster)
      joinedAt: Date.now(),
      lastSeen: Date.now(),
      connected: false,
      away: false,
      ws: null,
      graceTimer: null,
      lastAvatarAt: 0,
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

  // ---------- avatars ----------
  avatarPath(id) {
    if (!/^p\d+$/.test(id)) throw new Error('bad id');
    return path.join(this.avatarDir, id + '.jpg');
  }

  setAvatar(p, buf) {
    const tmp = this.avatarPath(p.id) + '.tmp';
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, this.avatarPath(p.id)); // atomic: readers never see half a file
    p.av += 1;
    p.lastAvatarAt = Date.now();
    this.save();
  }

  clearAvatar(p) {
    fs.rmSync(this.avatarPath(p.id), { force: true });
    if (p.av > 0) {
      p.av = 0;
      this.save();
    }
  }

  remove(id) {
    const p = this.byId.get(id);
    if (!p) return;
    clearTimeout(p.graceTimer);
    fs.rmSync(this.avatarPath(id), { force: true });
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
    const players = this.all().map(({ ws, graceTimer, connected, away, lastAvatarAt, ...rest }) => rest);
    const tmp = this.file + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify({ nextId: this.nextId, hueBase: this.hueBase, players }));
      fs.renameSync(tmp, this.file); // atomic: a power cut can't leave half a file
    } catch (e) {
      console.warn('[sessions] save failed:', e.message);
    }
  }
}

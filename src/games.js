// Game registry. Drop a folder into games/ (with game.json + server.js + client/) and it
// shows up in the lobby – no changes anywhere else. The folder is re-scanned on demand.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

export class GameRegistry {
  constructor({ dir, enabled, log }) {
    this.dir = dir;
    this.enabled = enabled || [];
    this.log = log;
    this.cache = [];
    this.scannedAt = 0;
  }

  /** Manifests of all valid games (cached for 2 s). */
  list(force = false) {
    if (!force && Date.now() - this.scannedAt < 2000) return this.cache;
    const out = [];
    let entries = [];
    try {
      entries = fs.readdirSync(this.dir, { withFileTypes: true });
    } catch {
      /* no games dir */
    }
    for (const e of entries) {
      if (!e.isDirectory() || !ID_RE.test(e.name)) continue;
      if (this.enabled.length && !this.enabled.includes(e.name)) continue;
      const manifest = this.readManifest(e.name);
      if (manifest) out.push(manifest);
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    this.cache = out;
    this.scannedAt = Date.now();
    return out;
  }

  readManifest(id) {
    const base = path.join(this.dir, id);
    try {
      const m = JSON.parse(fs.readFileSync(path.join(base, 'game.json'), 'utf8'));
      if (m.id !== id) throw new Error(`game.json id "${m.id}" must equal folder name "${id}"`);
      for (const f of ['server.js', 'client/player.js', 'client/host.js']) {
        if (!fs.existsSync(path.join(base, f))) throw new Error(`missing ${f}`);
      }
      return {
        id,
        name: String(m.name || id),
        description: String(m.description || ''),
        icon: String(m.icon || '🎮'),
        minPlayers: Math.max(1, Number(m.minPlayers) || 1),
        maxPlayers: Number(m.maxPlayers) || null,
        minutes: Number(m.minutes) || null,
      };
    } catch (e) {
      if (!this._warned?.has(id + e.message)) {
        (this._warned ||= new Set()).add(id + e.message);
        this.log.warn(`game "${id}" skipped: ${e.message}`);
      }
      return null;
    }
  }

  get(id) {
    return this.list().find((g) => g.id === id) || null;
  }

  /** Load the server module (fresh import so edits show up after a restart of the round). */
  async instantiate(id, ctx) {
    const file = path.join(this.dir, id, 'server.js');
    const mod = await import(pathToFileURL(file).href + '?t=' + Date.now());
    if (typeof mod.default !== 'function') throw new Error(`games/${id}/server.js must export default function(ctx)`);
    return mod.default(ctx);
  }

  /** Absolute path of a client asset, or null if it would escape the game's client dir. */
  clientFile(id, rel) {
    if (!ID_RE.test(id)) return null;
    const root = path.join(this.dir, id, 'client');
    const file = path.normalize(path.join(root, rel));
    if (!file.startsWith(root + path.sep)) return null;
    return file;
  }
}

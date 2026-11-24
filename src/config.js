// Configuration: built-in defaults  <  config.json  <  environment variables.
// Every option is documented in README.md ("Config reference").
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const defaults = {
  // Wi-Fi the Pi (or the external AP) broadcasts. Only used to draw the Wi-Fi QR code;
  // the actual AP is configured in the OS (see README, "Pi setup").
  wifi: {
    ssid: 'PartyBox',
    password: 'letsplay123', // '' = open network
    security: 'WPA', // WPA | WEP | nopass
    hidden: false,
  },

  network: {
    ip: '192.168.4.1', // Pi's address on the party network
  },

  server: {
    host: '0.0.0.0',
    httpPort: 8080, // use 80 on the Pi (setcap or authbind) so the URL has no port
    httpsPort: 8443, // use 443 on the Pi
    domain: '', // e.g. "party.example.com" – must resolve to network.ip via the Pi's DNS
    publicUrl: '', // full override of the URL shown in the join QR
    tls: {
      enabled: false,
      cert: '', // path to fullchain.pem for `domain`
      key: '', // path to privkey.pem
      redirectHttp: true, // when TLS is on, redirect http -> https
    },
  },

  players: {
    max: 12,
    nameMaxLength: 16,
    graceSeconds: 90, // disconnected player is shown "reconnecting" this long, then "away"
    sessionTtlHours: 12, // token is forgotten this long after the player was last seen
    heartbeatSeconds: 5,
  },

  lobby: {
    leaderCanControl: true, // first player (the "leader") can pick & start games from the phone
    hostPin: '', // if set, host screens that are NOT on the Pi itself must send it (?pin=...)
    allowJoinDuringGame: true,
  },

  games: {
    dir: 'games',
    enabled: [], // [] = every folder in games/ that has a valid game.json
    config: {
      // per-game overrides, handed to the game module as ctx.config
      'tap-race': { durationSeconds: 10, countdownSeconds: 3 },
    },
  },

  data: {
    dir: 'data',
    persistSessions: true, // survive a Pi restart / power blip
  },

  limits: {
    maxMessageBytes: 4096,
    messagesPerSecond: 40,
  },
};

function merge(base, extra) {
  if (!extra || typeof extra !== 'object') return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(extra)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = merge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// A few env overrides, handy for systemd units and tests.
const ENV = {
  PARTYBOX_HTTP_PORT: (c, v) => (c.server.httpPort = Number(v)),
  PARTYBOX_HTTPS_PORT: (c, v) => (c.server.httpsPort = Number(v)),
  PARTYBOX_DATA_DIR: (c, v) => (c.data.dir = v),
  PARTYBOX_SSID: (c, v) => (c.wifi.ssid = v),
  PARTYBOX_WIFI_PASSWORD: (c, v) => (c.wifi.password = v),
  PARTYBOX_DOMAIN: (c, v) => (c.server.domain = v),
};

export function loadConfig() {
  const file = process.env.PARTYBOX_CONFIG || path.join(ROOT, 'config.json');
  let cfg = structuredClone(defaults);
  if (fs.existsSync(file)) {
    try {
      cfg = merge(cfg, JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (e) {
      throw new Error(`Cannot parse ${file}: ${e.message}`);
    }
  }
  for (const [name, apply] of Object.entries(ENV)) {
    if (process.env[name] !== undefined && process.env[name] !== '') apply(cfg, process.env[name]);
  }
  cfg.data.dir = path.resolve(ROOT, cfg.data.dir);
  cfg.games.dir = path.resolve(ROOT, cfg.games.dir);
  return cfg;
}

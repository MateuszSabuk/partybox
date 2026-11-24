#!/usr/bin/env node
// Writes the production config.json (called by setup.sh / install-cert.sh).
//   node write-config.mjs --out FILE --ssid S --password P --ip IP --domain D --data-dir DIR [--tls auto|on|off] [--cert F --key F]
// Merges into an existing file so manual edits (e.g. games.config) survive a re-run.
import fs from 'node:fs';
import path from 'node:path';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1] ?? '';
if (!args.out) throw new Error('--out required');

let cfg = {};
if (fs.existsSync(args.out)) {
  try {
    cfg = JSON.parse(fs.readFileSync(args.out, 'utf8'));
    fs.copyFileSync(args.out, args.out + '.bak');
  } catch {
    cfg = {};
  }
}
const set = (obj, key, val) => ((obj[key] = { ...(obj[key] || {}) }), obj[key]);
const wifi = set(cfg, 'wifi');
const net = set(cfg, 'network');
const server = set(cfg, 'server');
const tls = set(server, 'tls');
const data = set(cfg, 'data');

if (args.ssid !== undefined) wifi.ssid = args.ssid;
if (args.password !== undefined) {
  wifi.password = args.password;
  wifi.security = args.password ? 'WPA' : 'nopass';
}
if (args.ip) net.ip = args.ip;
if (args.domain !== undefined) server.domain = args.domain;
server.httpPort = 80;
server.httpsPort = 443;
if (args['data-dir']) data.dir = args['data-dir'];
data.persistSessions = true;

const certFile = args.cert || tls.cert || '/etc/partybox/fullchain.pem';
const keyFile = args.key || tls.key || '/etc/partybox/privkey.pem';
const haveCerts = fs.existsSync(certFile) && fs.existsSync(keyFile);
const mode = args.tls || 'auto';
tls.cert = certFile;
tls.key = keyFile;
tls.redirectHttp = tls.redirectHttp ?? true;
tls.enabled = mode === 'on' ? true : mode === 'off' ? false : !!(server.domain && haveCerts);

fs.mkdirSync(path.dirname(args.out), { recursive: true });
fs.writeFileSync(args.out, JSON.stringify(cfg, null, 2) + '\n');
console.log(`config written: ${args.out}  (tls ${tls.enabled ? 'ON for ' + server.domain : 'off'})`);

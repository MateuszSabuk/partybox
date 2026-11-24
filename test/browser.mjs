// Real-browser check of the phone shell + host screen (Playwright/Chromium).
//   node test/browser.mjs [outDir]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, devices } from 'playwright';
import { defaults, ROOT } from '../src/config.js';
import { start } from '../src/server.js';

const out = process.argv[2] || path.join(os.tmpdir(), 'pb-shots');
fs.mkdirSync(out, { recursive: true });
const config = structuredClone(defaults);
config.server.httpPort = 0;
config.data.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-'));
config.games.dir = path.join(ROOT, 'games');
config.games.config['tap-race'] = { countdownSeconds: 1.5, durationSeconds: 4, resultsSeconds: 3 };
const app = await start(config);
const base = `http://127.0.0.1:${app.httpPort}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

const browser = await chromium.launch();
const tv = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
tv.on('pageerror', (e) => errors.push('tv: ' + e.message));
tv.on('console', (m) => m.type() === 'error' && errors.push('tv console: ' + m.text()));
await tv.goto(base + '/host');

const phoneCtx = async () => browser.newContext({ ...devices['Pixel 7'] });
const ctxA = await phoneCtx();
const a = await ctxA.newPage();
a.on('pageerror', (e) => errors.push('A: ' + e.message));
a.on('console', (m) => m.type() === 'error' && errors.push('A console: ' + m.text()));
await a.goto(base + '/');
await a.screenshot({ path: path.join(out, '1-join.png') });
await a.fill('#name', 'Alice');
await a.click('#joinForm button');
await a.waitForSelector('#v-lobby.on');

const b = await (await phoneCtx()).newPage();
b.on('pageerror', (e) => errors.push('B: ' + e.message));
await b.goto(base + '/');
await b.fill('#name', 'Bob');
await b.click('#joinForm button');
await b.waitForSelector('#v-lobby.on');
await sleep(300);
await a.screenshot({ path: path.join(out, '2-lobby-leader.png') });
await b.screenshot({ path: path.join(out, '3-lobby-other.png') });
await tv.screenshot({ path: path.join(out, '4-host-lobby.png') });

console.log('Bob can pick? ->', await b.locator('.game').first().isDisabled() ? 'no (correct)' : 'YES (bug)');
await a.click('.game');
await a.waitForSelector('.game.sel');
await a.click('#startBtn');
await a.waitForSelector('#game.on .tr');
await b.waitForSelector('#game.on .tr');
await sleep(1800);
for (let i = 0; i < 12; i++) await a.tap('#b').catch(() => {});
for (let i = 0; i < 5; i++) await b.tap('#b').catch(() => {});
await sleep(300);
await a.screenshot({ path: path.join(out, '5-game-phone.png') });
await tv.screenshot({ path: path.join(out, '6-host-game.png') });

// --- reconnect: Alice's page is fully reloaded (like a phone killing the tab). Token comes from storage.
await a.reload();
await a.waitForSelector('#game.on .tr');
const shown = await a.locator('#n').first().textContent();
console.log('Alice after reload shows taps =', shown);

await sleep(4500);
await a.waitForSelector('#v-lobby.on', { timeout: 10000 });
await a.screenshot({ path: path.join(out, '7-back-in-lobby.png') });
await tv.screenshot({ path: path.join(out, '8-host-after.png') });
console.log('Alice lobby score text:', await a.locator('#meScore').textContent());
console.log('Same token kept in lobby after game:', !!(await a.evaluate(() => localStorage.getItem('pb_token'))));

await browser.close();
await app.stop();
console.log(errors.length ? 'BROWSER ERRORS:\n' + errors.join('\n') : 'no browser errors');
console.log('screenshots in', out);
process.exit(errors.length ? 1 : 0);

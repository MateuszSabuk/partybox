// Real-browser check of the phone shell + host screen (Playwright/Chromium):
// join, lobby, photo picker + framing dialog, avatars on both screens, a full tap-race game,
// reload-reconnect, and a scan that NO emoji/pictograph characters are rendered anywhere.
//   node test/browser.mjs [outDir]        (needs `npm i -D playwright` or a global Playwright)
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
let checks = 0;
const ok = (cond, msg) => {
  checks++;
  console.log(cond ? '  ✓' : '  ✗ FAIL', msg);
  if (!cond) errors.push('check failed: ' + msg);
};
const shot = (page, name) => page.screenshot({ path: path.join(out, name) });

// Anything in these ranges is an emoji / pictograph / dingbat that needs an emoji font to look right.
const EMOJI = /[←-⯿✀-➿️\u{1F000}-\u{1FFFF}]/u;
async function noEmoji(page, label) {
  const bad = await page.evaluate(
    (src) => {
      const re = new RegExp(src, 'u');
      const text = document.body.innerText + '\n' + document.documentElement.outerHTML.replace(/<svg[\s\S]*?<\/svg>/g, '');
      const m = [...text].filter((c) => re.test(c));
      return [...new Set(m)].join(' ');
    },
    EMOJI.source,
  );
  ok(!bad, `no emoji/pictograph characters on ${label}${bad ? ' – found: ' + bad : ''}`);
}

const browser = await chromium.launch();
const tv = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
tv.on('pageerror', (e) => errors.push('tv: ' + e.message));
tv.on('console', (m) => m.type() === 'error' && errors.push('tv console: ' + m.text()));
await tv.goto(base + '/host');

const newPhone = async (label) => {
  const page = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage();
  page.on('pageerror', (e) => errors.push(label + ': ' + e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(label + ' console: ' + m.text()));
  return page;
};
const join = async (page, name) => {
  await page.goto(base + '/');
  await page.fill('#name', name);
  await page.click('#joinForm button');
  await page.waitForSelector('#v-lobby.on');
};

console.log('Join + lobby');
const a = await newPhone('A');
await a.goto(base + '/');
await shot(a, '1-join.png');
await noEmoji(a, 'join screen');
await join(a, 'Alice');
const b = await newPhone('B');
await join(b, 'Bob');
await sleep(300);
ok((await a.locator('#meAv .av svg').count()) === 1 && (await a.locator('#meAv .av img').count()) === 0, 'new player starts with a silhouette avatar (no photo)');
await noEmoji(a, 'phone lobby');

console.log('Photo: choose -> frame -> save');
await a.click('#meAv');
await a.waitForSelector('#avSheet:not([hidden])');
ok(await a.locator('#avRemove').isHidden(), '"Remove photo" is hidden while there is no photo');
await shot(a, '2-photo-menu.png');
await a.setInputFiles('#file', path.join(ROOT, 'test/fixtures/photo.jpg'));
await a.waitForSelector('#crop:not([hidden])');
await sleep(200);
ok(await a.locator('#avSheet').isHidden(), 'photo menu closes when a file is chosen');
const box = await a.locator('#stage').boundingBox();
ok(Math.abs(box.width - box.height) < 1 && box.width > 150, `framing stage is square and big enough (${Math.round(box.width)}px)`);
await shot(a, '3-frame-initial.png');
// drag the picture and zoom in, like a thumb would
await a.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await a.mouse.down();
await a.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 30, { steps: 5 });
await a.mouse.up();
await a.evaluate(() => {
  const z = document.getElementById('zoom');
  z.value = '2';
  z.dispatchEvent(new Event('input'));
});
await sleep(100);
const tr = await a.locator('#cropImg').evaluate((i) => i.style.transform);
ok(/translate\(/.test(tr), 'dragging/zooming moves the picture inside the frame (' + tr + ')');
await shot(a, '4-frame-zoomed.png');
await a.click('#cropSave');
await a.waitForSelector('#meAv img', { timeout: 5000 });
ok(await a.locator('#crop').isHidden(), 'framing dialog closes after saving');
await sleep(500);
const dim = await a.locator('#meAv img').evaluate((i) => [i.naturalWidth, i.naturalHeight]);
ok(dim[0] === 192 && dim[1] === 192, `uploaded avatar is a 192x192 square JPEG (${dim.join('x')})`);
const saved = fs.readdirSync(path.join(config.data.dir, 'avatars')).map((f) => fs.statSync(path.join(config.data.dir, 'avatars', f)).size);
ok(saved.length === 1 && saved[0] < 30000, `stored file is small (${saved[0]} bytes)`);
await shot(a, '5-lobby-with-photo.png');

console.log('Everyone sees it');
await b.waitForSelector('#chips .av img', { timeout: 5000 });
ok((await b.locator('#chips .av img').count()) === 1 && (await b.locator('#chips .av svg').count()) >= 1, "Bob sees Alice's photo and his own silhouette in the player list");
await tv.waitForSelector('.tile .av img', { timeout: 5000 });
ok((await tv.locator('.tile').count()) === 2 && (await tv.locator('.tile .av img').count()) === 1, 'TV shows 2 player tiles, one with a photo');
const loaded = await tv.locator('.tile .av img').evaluate((i) => i.complete && i.naturalWidth > 0);
ok(loaded, 'TV avatar image actually loads');
await shot(b, '6-lobby-other-phone.png');
await shot(tv, '7-host-lobby.png');
await noEmoji(tv, 'TV lobby');
const gi = await tv.locator('.gl .gicon img').evaluate((i) => i.complete && i.naturalWidth > 0);
ok(gi, 'game icon (SVG file from the game module) loads on the TV');
const gp = await a.locator('#games .gicon img').evaluate((i) => i.complete && i.naturalWidth > 0);
ok(gp, 'game icon loads on the phone');

console.log('Change + remove photo any time in the lobby');
await a.click('#meAv');
ok(await a.locator('#avRemove').isVisible(), '"Remove photo" appears once a photo exists');
await a.click('#avRemove');
await a.waitForSelector('#meAv .av svg', { timeout: 5000 });
ok((await a.locator('#meAv .av img').count()) === 0, 'removing the photo brings back the silhouette');
await sleep(1100);
await a.click('#meAv');
await a.setInputFiles('#file', path.join(ROOT, 'test/fixtures/photo.jpg'));
await a.waitForSelector('#crop:not([hidden])');
await a.click('#cropSave');
await a.waitForSelector('#meAv img', { timeout: 5000 });
ok(true, 'a new photo can be chosen again');

console.log('A broken file is handled');
await a.click('#meAv');
await a.setInputFiles('#file', { name: 'bad.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('this is not an image') });
await a.waitForSelector('#toast.on', { timeout: 5000 });
ok(/open that photo/.test(await a.locator('#toast').textContent()), 'unreadable photo shows a friendly message');
ok(await a.locator('#crop').isHidden(), 'no stuck dialog after a bad file');

console.log('Game: tap race with avatars');
await a.click('.game');
await a.waitForSelector('.game.sel');
await a.click('#startBtn');
await a.waitForSelector('#game.on .tr');
await b.waitForSelector('#game.on .tr');
await sleep(1900);
for (let i = 0; i < 12; i++) await a.tap('#b').catch(() => {});
for (let i = 0; i < 5; i++) await b.tap('#b').catch(() => {});
await sleep(400);
await shot(a, '8-game-phone.png');
await shot(tv, '9-host-game.png');
ok((await tv.locator('.trh .av').count()) === 2, 'TV race bars show both avatars');
await noEmoji(tv, 'TV game screen');
await noEmoji(a, 'phone game screen');

await a.reload(); // phone killed the tab: token comes back from storage
await a.waitForSelector('#game.on .tr');
ok(true, 'reload mid-game: back in the game with the same token');

await sleep(2600);
await a.waitForSelector('.medal', { timeout: 6000 }).catch(() => {});
await shot(a, '10-result-phone.png');
await shot(tv, '11-host-results.png');
ok((await tv.locator('.trh .medal').count()) === 2, 'TV results show medal badges (SVG/CSS, no emoji)');
await noEmoji(tv, 'TV results');
await a.waitForSelector('#v-lobby.on', { timeout: 10000 });
await sleep(300);
ok((await a.locator('#meAv img').count()) === 1, 'photo is still there after the game (same token/session)');
await shot(a, '12-back-in-lobby.png');
await shot(tv, '13-host-after.png');
await noEmoji(a, 'phone lobby after game');

await browser.close();
await app.stop();
console.log(errors.length ? '\nERRORS:\n' + errors.join('\n') : `\nno browser errors, ${checks} checks passed`);
console.log('screenshots in', out);
process.exit(errors.length ? 1 : 0);

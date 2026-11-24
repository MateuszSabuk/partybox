// Phone shell: join -> lobby -> (any game) with ONE token and ONE socket for all of it.
import { armFullscreenOnFirstTouch, canFullscreen, enterFullscreen, isIOS, isStandalone, setOrientation } from './fs.js';
import { createGameHost } from './gameloader.js';
import { createLink } from './link.js';

const $ = (id) => document.getElementById(id);
const store = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v);
    } catch {}
  },
};
// Token lives in localStorage AND a cookie (set by /api/join). Either is enough to get back in.
const cookieToken = () => /(?:^|;\s*)pb_token=([0-9a-f]{32})/.exec(document.cookie)?.[1] || null;
const getToken = () => store.get('pb_token') || cookieToken();
const saveToken = (t) => {
  store.set('pb_token', t);
  document.cookie = `pb_token=${t}; Path=/; Max-Age=${12 * 3600}; SameSite=Lax`;
};
const clearToken = () => {
  store.set('pb_token', null);
  document.cookie = 'pb_token=; Path=/; Max-Age=0';
};

let me = null;
let state = null;
const views = ['join', 'wait', 'lobby'];
function show(name) {
  for (const v of views) $('v-' + v).classList.toggle('on', v === name);
  if (name !== 'game') game.close();
}

// ---------- game host ----------
const game = createGameHost({
  role: 'player',
  root: $('game'),
  makeApi: () => ({
    send: (d) => link.send({ t: 'game', d }),
    get me() {
      return me;
    },
    players: () => state?.players || [],
    orientation: setOrientation,
    latency: () => link.latency,
  }),
});

// ---------- connection ----------
const link = createLink({
  hello: () => ({ t: 'hello', role: 'player', token: getToken() }),
  onStatus(s, code) {
    $('status').classList.toggle('on', s === 'reconnecting' || s === 'connecting');
    if (s === 'closed') {
      show('wait');
      $('waitMsg').textContent = code === 4000 ? 'PartyBox is open in another tab or phone.' : 'You were removed from the party.';
      $('rejoin').hidden = false;
      $('rejoin').textContent = code === 4000 ? 'Use this device instead' : 'Join again';
      $('rejoin').onclick = () => {
        if (code === 4001) clearToken();
        $('rejoin').hidden = true;
        code === 4001 ? show('join') : link.resume();
      };
    }
  },
  onMessage(m) {
    switch (m.t) {
      case 'need-join':
        clearToken();
        link.stop();
        show('join');
        break;
      case 'welcome':
        me = m.you;
        break;
      case 'state':
        state = m;
        render();
        break;
      case 'game':
        game.message(m.d, m.snap);
        break;
    }
  },
});

// ---------- rendering ----------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function render() {
  if (!state || !me) return;
  const mine = state.players.find((p) => p.id === me.id);
  if (mine) me.name = mine.name;

  if (state.phase === 'game' && state.active) {
    for (const v of views) $('v-' + v).classList.remove('on');
    game.open(state.active.id);
    game.mod?.playersChanged?.(state.players);
    return;
  }
  show('lobby');
  $('meName').textContent = me.name;
  $('meScore').textContent = (mine?.score ?? 0) + ' pts';
  $('chips').innerHTML = state.players
    .map((p) => `<span class="chip ${p.on ? '' : 'off'} ${p.id === me.id ? 'me' : ''}"><i></i>${esc(p.name)}${p.score ? ' · ' + p.score : ''}</span>`)
    .join('');

  const isLeader = state.leader === me.id;
  const leaderName = state.players.find((p) => p.id === state.leader)?.name;
  $('pickTitle').textContent = isLeader ? 'Pick a game' : 'Games';
  $('games').innerHTML = state.games.length
    ? state.games
        .map(
          (g) => `<button class="game ${g.id === state.selected ? 'sel' : ''}" data-id="${g.id}" ${isLeader ? '' : 'disabled style="opacity:1"'}>
            <span class="ico">${esc(g.icon)}</span><span><b>${esc(g.name)}</b><small>${esc(g.description)}</small></span></button>`,
        )
        .join('')
    : '<div class="hint">No games installed. Drop a folder into games/.</div>';

  const start = $('startBtn');
  start.hidden = !isLeader;
  start.disabled = !state.canStart;
  start.textContent = state.selected ? 'Start ' + (state.games.find((g) => g.id === state.selected)?.name || '') : 'Choose a game first';

  const r = state.last;
  $('lobbyMsg').textContent = isLeader
    ? r
      ? `${r.game} finished – pick the next game!`
      : 'You are the leader – pick a game and start it.'
    : r
      ? `${r.game} finished. Waiting for ${leaderName ?? 'the leader'}…`
      : `Waiting for ${leaderName ?? 'the leader'} to pick a game…`;
}

$('games').addEventListener('click', (e) => {
  const b = e.target.closest('.game');
  if (b && !b.disabled) link.send({ t: 'lobby:select', game: b.dataset.id });
});
$('startBtn').addEventListener('click', () => link.send({ t: 'lobby:start' }));

// ---------- joining ----------
$('joinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  enterFullscreen(); // must happen synchronously inside the tap
  const name = $('name').value.trim();
  if (!name) return;
  store.set('pb_name', name);
  $('joinErr').textContent = '';
  try {
    const r = await fetch('/api/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
    const j = await r.json();
    if (!r.ok) {
      $('joinErr').textContent = j.error === 'full' ? 'The party is full.' : j.error === 'running' ? 'A game is running – try again later.' : 'Please enter a name.';
      return;
    }
    saveToken(j.token);
    show('wait');
    $('waitMsg').textContent = 'Connecting…';
    link.resume();
  } catch {
    $('joinErr').textContent = 'Cannot reach the party. Are you on the PartyBox Wi-Fi?';
  }
});

// ---------- boot ----------
$('name').value = store.get('pb_name') || '';
if (isIOS() && !isStandalone()) $('iosHint').hidden = false;
if (getToken()) {
  show('wait'); // returning player: straight back in, no questions asked
  armFullscreenOnFirstTouch();
  link.resume();
} else {
  show('join');
}
// the first tap anywhere also tries fullscreen on browsers that have it
if (!canFullscreen()) $('joinForm').querySelector('button').textContent = 'Join';

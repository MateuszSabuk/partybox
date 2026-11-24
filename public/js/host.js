// Host (TV) screen. Open http://localhost:<port>/host in kiosk mode on the Pi.
import { createGameHost } from './gameloader.js';
import { createLink } from './link.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const pin = new URLSearchParams(location.search).get('pin') || undefined;
let state = null;

const game = createGameHost({
  role: 'host',
  root: $('game'),
  makeApi: () => ({ send: (d) => link.send({ t: 'game', d }), players: () => state?.players || [] }),
});

const link = createLink({
  hello: () => ({ t: 'hello', role: 'host', pin }),
  onStatus(s, code) {
    $('conn').classList.toggle('on', s === 'reconnecting');
    if (s === 'closed' && code === 4003) $('hostHint').textContent = 'Host denied – add ?pin=… to the URL.';
  },
  onMessage(m) {
    if (m.t === 'state') {
      state = m;
      render();
    } else if (m.t === 'game') game.message(m.d, m.snap);
  },
});

fetch('/api/info')
  .then((r) => r.json())
  .then((i) => {
    $('qrWifi').innerHTML = i.wifiQr;
    $('qrJoin').innerHTML = i.joinQr;
    $('ssid').innerHTML = `${esc(i.ssid)}${i.password ? '<br>password: ' + esc(i.password) : ''}`;
    $('url').textContent = i.joinUrl;
  });

function render() {
  const inGame = state.phase === 'game' && state.active;
  $('lobby').style.display = inGame ? 'none' : 'grid';
  $('stop').hidden = !inGame;
  if (inGame) {
    game.open(state.active.id);
    game.mod?.playersChanged?.(state.players);
    return;
  }
  game.close();
  const on = state.players.filter((p) => p.on).length;
  $('count').textContent = `${on}/${state.max}`;
  $('players').innerHTML = state.players.length
    ? state.players.map((p) => `<span class="chip ${p.on ? '' : 'off'}"><i></i>${esc(p.name)}${p.score ? ' · ' + p.score : ''}</span>`).join('')
    : '<span class="muted" style="font-size:3vh">Scan the codes to join…</span>';

  const leader = state.players.find((p) => p.id === state.leader);
  $('msg').textContent = state.last
    ? `${state.last.game} finished!${leader ? ' ' + leader.name + ' picks the next game.' : ''}`
    : leader
      ? `${leader.name} is the leader and picks the game on their phone.`
      : '';
  $('games').innerHTML = state.games
    .map((g) => `<div class="game ${g.id === state.selected ? 'sel' : ''}" data-id="${g.id}"><span class="ico">${esc(g.icon)}</span><span><b>${esc(g.name)}</b><small>${esc(g.description)}</small></span></div>`)
    .join('');
}

// Host can also drive the lobby with mouse/keyboard (handy when testing without phones)
$('games').addEventListener('click', (e) => {
  const g = e.target.closest('.game');
  if (!g) return;
  if (state.selected === g.dataset.id && state.canStart) link.send({ t: 'lobby:start' });
  else link.send({ t: 'lobby:select', game: g.dataset.id });
});
$('stop').addEventListener('click', () => link.send({ t: 'lobby:stop' }));
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') link.send({ t: 'lobby:stop' });
  if (e.key === 'Enter' && state?.canStart) link.send({ t: 'lobby:start' });
});
link.resume();

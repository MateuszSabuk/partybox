// Phone side of Tap Race.
//
// Contract:  export function mount(root, api) -> { message(d, isSnapshot), unmount() }
//   root  – an empty, full-screen <div> you own
//   api   – { send(d), me:{id,name}, players(), orientation('portrait'|'landscape'|'any'), latency(), ui }
//           api.ui = { avatar(player,size), medal(rank,size), icons, esc }  – use these instead of emoji
export function mount(root, api) {
  root.innerHTML = `
    <style>
      .tr{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1.2rem;text-align:center;padding:1rem}
      .tr h1{font-size:clamp(2rem,12vw,4rem);margin:0}
      .tr .big{font-size:clamp(4rem,30vw,9rem);font-weight:800;line-height:1;font-variant-numeric:tabular-nums}
      .tr button.tap{width:min(80vw,60vh);aspect-ratio:1;border-radius:50%;border:0;font:800 2.2rem system-ui;color:#fff;
        background:radial-gradient(circle at 35% 30%,#ff8a5c,#e8412b);box-shadow:0 12px 0 #8d2112,0 24px 40px #0008;touch-action:none}
      .tr button.tap:active{transform:translateY(8px);box-shadow:0 4px 0 #8d2112,0 10px 20px #0008}
      .tr small{opacity:.7}
    </style>
    <div class="tr"></div>`;
  const view = root.querySelector('.tr');

  let phase = 'countdown', endsAt = 0, mine = 0, sent = 0, timer = null, tapBtn = null, spectator = false, result = null;
  const left = () => Math.max(0, endsAt - performance.now());

  function setClock(ms) {
    endsAt = performance.now() + ms;
  }

  function render() {
    clearInterval(timer);
    tapBtn = null;
    if (phase === 'countdown') {
      view.innerHTML = `<h1>Get ready…</h1><div class="big" id="n">3</div><small>Tap as fast as you can!</small>`;
      timer = setInterval(() => (view.querySelector('#n').textContent = Math.max(1, Math.ceil(left() / 1000))), 100);
    } else if (phase === 'play') {
      if (spectator) {
        view.innerHTML = `<h1>Spectating</h1><small>You joined late – you'll play next round.</small>`;
        return;
      }
      view.innerHTML = `<div class="big" id="n">${mine}</div><button class="tap" id="b">TAP!</button><small id="t"></small>`;
      tapBtn = view.querySelector('#b');
      tapBtn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        mine++;
        view.querySelector('#n').textContent = mine;
        navigator.vibrate?.(8);
      });
      timer = setInterval(() => {
        view.querySelector('#t').textContent = (left() / 1000).toFixed(1) + ' s';
        flush();
      }, 80);
    } else {
      const r = result;
      view.innerHTML = r
        ? `<h1>${api.ui.medal(r.rank, '5.5rem')}</h1><div class="big">${r.taps}</div><small>taps · ${r.points != null ? '+' + r.points + ' points' : ''}</small>`
        : `<h1>Round over</h1>`;
    }
  }

  // Taps are sent in small batches every ~80 ms instead of one message per tap.
  function flush() {
    if (mine > sent) {
      const n = Math.min(8, mine - sent);
      sent += n;
      api.send({ type: 'tap', n });
    }
  }

  render();
  return {
    message(d, isSnapshot) {
      if (isSnapshot) {
        phase = d.phase;
        setClock(d.msLeft);
        mine = d.taps; // server's count wins after a reconnect
        sent = d.taps;
        spectator = d.spectator;
        result = d.result;
        render();
      } else if (d.type === 'phase') {
        phase = d.phase;
        setClock(d.msLeft);
        render();
      } else if (d.type === 'result') {
        result = d;
        if (phase === 'results') render();
      }
    },
    unmount() {
      clearInterval(timer);
      root.innerHTML = '';
    },
  };
}

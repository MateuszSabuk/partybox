// TV side of Tap Race.
// Contract:  export function mount(root, api) -> { message(d, isSnapshot), unmount() }
//   api = { send(d), players() }   players() -> [{id,name,score,on,away}]
export function mount(root, api) {
  root.innerHTML = `
    <style>
      .trh{height:100%;padding:3vh 4vw;display:flex;flex-direction:column;gap:2vh}
      .trh h1{margin:0;font-size:5vh;display:flex;justify-content:space-between}
      .trh .rows{display:grid;gap:1vh}
      .trh .row{display:grid;grid-template-columns:18vw 1fr 6vw;align-items:center;gap:1.5vw;font-size:3vh}
      .trh .bar{height:3.4vh;border-radius:2vh;background:#ffffff14;overflow:hidden}
      .trh .bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,#ff8a5c,#e8412b);transition:width .12s linear}
      .trh .name.off{opacity:.4}
    </style>
    <div class="trh"><h1><span>👆 Tap Race</span><span id="clock"></span></h1><div class="rows" id="rows"></div></div>`;
  const rows = root.querySelector('#rows');
  const clock = root.querySelector('#clock');
  let phase = 'countdown', counts = {}, board = null, endsAt = 0, timer;

  const clockText = () => {
    const s = Math.max(0, (endsAt - performance.now()) / 1000);
    clock.textContent = phase === 'countdown' ? 'Starting in ' + Math.ceil(s) : phase === 'play' ? s.toFixed(1) + ' s' : 'Results';
  };

  function draw() {
    const ps = api.players().filter((p) => p.id in counts);
    const max = Math.max(10, ...Object.values(counts));
    const order = board ? board.map((r) => r.id) : ps.map((p) => p.id);
    rows.innerHTML = order
      .map((id, i) => {
        const p = ps.find((x) => x.id === id);
        if (!p) return '';
        const n = counts[id] || 0;
        return `<div class="row"><span class="name ${p.on ? '' : 'off'}">${board ? ['🥇', '🥈', '🥉'][i] || i + 1 + '.' : ''} ${esc(p.name)}${p.on ? '' : ' ⟳'}</span>
          <div class="bar"><i style="width:${(n / max) * 100}%"></i></div><b>${n}</b></div>`;
      })
      .join('');
  }
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  timer = setInterval(clockText, 100);
  return {
    message(d, isSnapshot) {
      if (isSnapshot || d.type === 'phase') {
        phase = d.phase;
        endsAt = performance.now() + d.msLeft;
        counts = d.counts || counts;
        board = d.board ?? null;
      } else if (d.type === 'counts') {
        counts = d.counts;
        endsAt = performance.now() + d.msLeft;
      }
      draw();
    },
    playersChanged: draw, // optional hook: called when someone connects/disconnects
    unmount() {
      clearInterval(timer);
      root.innerHTML = '';
    },
  };
}

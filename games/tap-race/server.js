// Tap Race – a deliberately tiny GAME MODULE that shows the whole contract.
//
// A game is a folder:  games/<id>/{game.json, server.js, client/player.js, client/host.js}
// server.js default-exports a factory that receives `ctx` and returns hooks.
//
//   ctx.config                  per-game config from config.json -> games.config.<id>
//   ctx.players()               [{id,name,score,on,away}]  (same ids/tokens as the lobby)
//   ctx.send(id, d)             message to one phone       ctx.sendAll(d)   to every phone
//   ctx.sendHost(d)             message to the TV screen
//   ctx.setTimeout/setInterval  auto-cleaned when the game ends
//   ctx.endGame(points, info)   add {playerId: points} to the scores and go back to the lobby
//
// Hooks (all optional):
//   start()  snapshot(player)  hostSnapshot()  onMessage(player, d)  onHostMessage(d)
//   onPlayerJoin(p)  onPlayerDisconnect(p)  onPlayerReconnect(p)  onPlayerAway(p)  destroy()
//
// snapshot()/hostSnapshot() are sent on (re)connect – this is what makes "come back
// mid-game" work: they must describe the COMPLETE current state of the game.

export default function create(ctx) {
  const countdownMs = (ctx.config.countdownSeconds ?? 3) * 1000;
  const playMs = (ctx.config.durationSeconds ?? 10) * 1000;
  const resultsMs = (ctx.config.resultsSeconds ?? 8) * 1000;

  let phase = 'countdown'; // countdown -> play -> results
  let phaseEnds = Date.now() + countdownMs;
  let board = null; // final standings
  const taps = new Map(); // playerId -> count
  const players = new Set(ctx.players().filter((p) => p.on).map((p) => p.id)); // participants

  const msLeft = () => Math.max(0, phaseEnds - Date.now());
  const counts = () => Object.fromEntries([...players].map((id) => [id, taps.get(id) || 0]));

  function standings() {
    return [...players]
      .map((id) => ({ id, taps: taps.get(id) || 0 }))
      .sort((a, b) => b.taps - a.taps)
      .map((r, i) => ({ ...r, rank: i + 1 }));
  }

  function setPhase(next, ms) {
    phase = next;
    phaseEnds = Date.now() + ms;
    ctx.sendAll({ type: 'phase', phase, msLeft: ms });
    ctx.sendHost({ type: 'phase', phase, msLeft: ms, counts: counts(), board });
  }

  return {
    start() {
      ctx.setTimeout(() => {
        setPhase('play', playMs);
        const tick = ctx.setInterval(() => ctx.sendHost({ type: 'counts', counts: counts(), msLeft: msLeft() }), 100);
        ctx.setTimeout(() => {
          ctx.clear(tick);
          board = standings();
          const points = {};
          board.forEach((r) => (points[r.id] = [10, 7, 5][r.rank - 1] ?? 2));
          setPhase('results', resultsMs);
          for (const r of board) ctx.send(r.id, { type: 'result', rank: r.rank, taps: r.taps, points: points[r.id] });
          ctx.setTimeout(() => ctx.endGame(points, board.slice(0, 3).map((r) => r.id)), resultsMs);
        }, playMs);
      }, countdownMs);
    },

    // What a phone needs to redraw itself from scratch (also used after reconnect).
    snapshot(player) {
      const rank = board?.find((r) => r.id === player.id);
      return {
        phase,
        msLeft: msLeft(),
        taps: taps.get(player.id) || 0,
        spectator: !players.has(player.id),
        result: rank ? { rank: rank.rank, taps: rank.taps } : null,
      };
    },

    hostSnapshot() {
      return { phase, msLeft: msLeft(), counts: counts(), board };
    },

    onMessage(player, d) {
      // phones batch taps ({type:'tap', n}) to save bandwidth; clamp so nobody can cheat
      if (d?.type === 'tap' && phase === 'play' && players.has(player.id)) {
        const n = Math.min(8, Math.max(0, Math.floor(Number(d.n) || 0)));
        taps.set(player.id, (taps.get(player.id) || 0) + n);
      }
    },

    onPlayerJoin(p) {
      if (phase === 'countdown') players.add(p.id); // late joiners may only watch once play starts
    },
  };
}

// Self-healing WebSocket used by both the phone shell and the host screen.
// - exponential backoff + jitter, instant retry when the tab becomes visible / network returns
// - app-level ping every 4 s: browsers don't expose WS ping frames, and a phone that
//   locked its screen often keeps a "zombie" socket that looks open but is dead.
export function createLink({ hello, onMessage, onStatus }) {
  let ws = null;
  let tries = 0;
  let retryTimer = null;
  let pingTimer = null;
  let lastPong = 0;
  let stopped = false;
  let latency = 0;

  const url = () => (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';

  function connect() {
    clearTimeout(retryTimer);
    if (stopped || (ws && ws.readyState <= 1)) return;
    onStatus('connecting');
    const sock = (ws = new WebSocket(url()));
    sock.onopen = () => {
      tries = 0;
      lastPong = Date.now();
      sock.send(JSON.stringify(hello()));
      clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (Date.now() - lastPong > 11000) return drop(sock);
        send({ t: 'ping', c: Date.now() });
      }, 4000);
      onStatus('open');
    };
    sock.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.t === 'pong') {
        lastPong = Date.now();
        latency = lastPong - m.c;
        return;
      }
      onMessage(m);
    };
    sock.onclose = (e) => {
      if (sock !== ws) return;
      clearInterval(pingTimer);
      // 4000 = same player opened elsewhere, 4001 = kicked/reset, 4003 = host denied: don't fight
      if (e.code === 4000 || e.code === 4001 || e.code === 4003) {
        stopped = true;
        return onStatus('closed', e.code);
      }
      onStatus('reconnecting');
      retryTimer = setTimeout(connect, Math.min(3000, 250 * 2 ** tries++) + Math.random() * 250);
    };
    sock.onerror = () => {};
  }

  function drop(sock) {
    sock.onclose = null;
    try {
      sock.close();
    } catch {}
    clearInterval(pingTimer);
    onStatus('reconnecting');
    ws = null;
    retryTimer = setTimeout(connect, 200);
  }

  function send(m) {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(m));
      return true;
    }
    return false;
  }

  const wake = () => {
    if (stopped) return;
    if (!ws || ws.readyState > 1) return (tries = 0, connect());
    send({ t: 'ping', c: Date.now() }); // verify a "zombie" socket quickly
    lastPong = Math.min(lastPong, Date.now() - 7000); // -> dropped within ~4 s if dead
  };
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && wake());
  addEventListener('online', wake);
  addEventListener('pageshow', wake);

  return {
    connect,
    send,
    get latency() {
      return latency;
    },
    resume() {
      stopped = false;
      tries = 0;
      connect();
    },
    stop() {
      stopped = true;
      clearTimeout(retryTimer);
      clearInterval(pingTimer);
      ws?.close();
    },
  };
}

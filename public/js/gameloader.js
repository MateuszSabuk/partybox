// Loads games/<id>/client/{player|host}.js on demand and feeds it messages.
// Messages that arrive while the module is still downloading are queued, so a
// reconnect snapshot can never be lost.
export function createGameHost({ role, root, makeApi }) {
  let current = null; // { id, mod, queue, dead }

  async function open(id) {
    if (current?.id === id) return;
    close();
    const slot = (current = { id, mod: null, queue: [], dead: false });
    root.classList.add('on');
    try {
      const m = await import(`/games/${id}/client/${role}.js`);
      if (slot.dead) return;
      const inner = document.createElement('div');
      inner.style.cssText = 'position:absolute;inset:0;overflow:hidden';
      root.appendChild(inner);
      slot.inner = inner;
      slot.mod = m.mount(inner, makeApi(id));
      for (const [d, snap] of slot.queue) slot.mod.message?.(d, snap);
      slot.queue = [];
    } catch (e) {
      console.error('game client failed to load', id, e);
      root.textContent = 'Could not load game: ' + e.message;
    }
  }

  function message(d, isSnapshot) {
    if (!current) return;
    if (current.mod) current.mod.message?.(d, !!isSnapshot);
    else current.queue.push([d, !!isSnapshot]);
  }

  function close() {
    if (!current) return;
    current.dead = true;
    try {
      current.mod?.unmount?.();
    } catch {}
    root.replaceChildren();
    root.classList.remove('on');
    current = null;
  }

  return { open, message, close, get id() { return current?.id; }, get mod() { return current?.mod; } };
}

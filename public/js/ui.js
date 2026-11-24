// Shared UI pieces: inline-SVG icons (no emoji – emoji fonts are missing on many Linux/Pi browsers),
// avatars and medals. Games receive this as `api.ui`.

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- icons ----------
export const icons = {
  // party popper: cone + confetti
  logo: `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M8 57 22 19l23 23z" fill="#ff7a45"/><path d="M22 19l23 23-5 4L18 23z" fill="#ffb199"/><path d="M8 57l7-19 12 12z" fill="#e8412b"/>
    <circle cx="40" cy="14" r="3.2" fill="#3ddc97"/><circle cx="55" cy="30" r="3" fill="#ffcc4d"/><circle cx="50" cy="9" r="2.2" fill="#7c5cff"/>
    <rect x="30" y="6" width="7" height="3.6" rx="1" fill="#7c5cff" transform="rotate(35 33 8)"/><rect x="54" y="18" width="7" height="3.6" rx="1" fill="#3ddc97" transform="rotate(-30 57 20)"/>
    <rect x="44" y="26" width="6" height="3.2" rx="1" fill="#ff7a45" transform="rotate(60 47 28)"/><path d="M26 10c4 3 2 7 6 9" fill="none" stroke="#ffcc4d" stroke-width="2.4" stroke-linecap="round"/></svg>`,
  wifi: `<svg viewBox="0 0 64 64" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"><path d="M8 26a34 34 0 0 1 48 0"/><path d="M16 35a22 22 0 0 1 32 0"/><path d="M24 44a10 10 0 0 1 16 0"/><circle cx="32" cy="52" r="2.5" fill="currentColor"/></svg>`,
  camera: `<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M9 3 7.2 5H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3.2L15 3zm3 5.2a4.6 4.6 0 1 1 0 9.2 4.6 4.6 0 0 1 0-9.2zm0 2a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2z"/></svg>`,
  // generic game controller, used when a game ships no icon
  gamepad: `<svg viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="14" fill="#7c5cff"/><path d="M18 22h28c5 0 8 4 9 10l2 10c.7 4-2 7-6 6-2 0-4-1-5-3l-3-4H21l-3 4c-1 2-3 3-5 3-4 1-6.7-2-6-6l2-10c1-6 4-10 9-10z" fill="#fff"/><path d="M22 28v8M18 32h8" stroke="#7c5cff" stroke-width="3" stroke-linecap="round"/><circle cx="41" cy="30" r="2.3" fill="#ff7a45"/><circle cx="46" cy="35" r="2.3" fill="#3ddc97"/></svg>`,
};

/** Game icon: manifest `icon` pointing at an .svg/.png in the game's client folder -> <img>, else the generic pad. */
export function gameIcon(g, size = '2.4rem') {
  const inner = g.iconUrl ? `<img src="${esc(g.iconUrl)}" alt="" draggable="false">` : icons.gamepad;
  return `<span class="gicon" style="--s:${size}">${inner}</span>`;
}

// ---------- avatars ----------
const hsl = (h, s, l) => `hsl(${h} ${s}% ${l}%)`;

/**
 * Player avatar: their framed photo, or a silhouette in their personal colour.
 * p = {id, color(hue 0-359), av(version, 0 = none), on?}
 */
export function avatar(p, size = '3rem', cls = '') {
  const h = Number.isFinite(p.color) ? p.color : 210;
  const ring = hsl(h, 75, 62);
  const body = p.av
    ? `<img src="/avatar/${encodeURIComponent(p.id)}.jpg?v=${p.av}" alt="" draggable="false" loading="lazy">`
    : `<svg viewBox="0 0 100 100" aria-hidden="true"><rect width="100" height="100" fill="${hsl(h, 55, 40)}"/><circle cx="50" cy="38" r="17" fill="${hsl(h, 60, 80)}"/><path d="M16 100c0-22 15-37 34-37s34 15 34 37z" fill="${hsl(h, 60, 80)}"/></svg>`;
  return `<span class="av ${p.on === false ? 'off' : ''} ${cls}" style="--s:${size};--ring:${ring}">${body}</span>`;
}

// ---------- medals ----------
/** Rank badge: gold/silver/bronze disc for 1-3, plain number chip otherwise. */
export function medal(rank, size = '2rem') {
  return `<span class="medal m${rank <= 3 ? rank : 0}" style="--s:${size}">${rank}</span>`;
}

export const ui = { esc, icons, gameIcon, avatar, medal };

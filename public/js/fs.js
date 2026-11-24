// "As fullscreen as the platform allows".
//  Android Chrome / desktop : real Fullscreen API (needs a user gesture -> call from a tap handler)
//  iPhone Safari            : API does not exist; only "Add to Home Screen" gives a chrome-less view
const root = document.documentElement;
const reqFs = root.requestFullscreen || root.webkitRequestFullscreen;

export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches || navigator.standalone === true;
export const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const canFullscreen = () => !!reqFs;
export const isFullscreen = () => !!(document.fullscreenElement || document.webkitFullscreenElement) || isStandalone();

let wantedOrientation = 'portrait';
let wakeLock = null;

async function lockOrientation() {
  try {
    if (wantedOrientation === 'any') screen.orientation.unlock();
    else await screen.orientation.lock(wantedOrientation);
  } catch {} // only works in fullscreen on Chromium – silently ignore elsewhere
}

async function keepAwake() {
  try {
    if (navigator.wakeLock && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen'); // secure contexts only (HTTPS / localhost)
      wakeLock.addEventListener('release', () => (wakeLock = null));
    }
  } catch {}
}
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && keepAwake());

/** Call inside a user-gesture handler (tap / submit). Safe to call repeatedly. */
export function enterFullscreen() {
  keepAwake();
  if (!reqFs || isFullscreen()) return;
  try {
    const p = reqFs.call(root, { navigationUI: 'hide' });
    if (p && p.then) p.then(lockOrientation, () => {});
  } catch {}
}

/** Games call this through api.orientation('landscape'|'portrait'|'any'). */
export function setOrientation(o) {
  wantedOrientation = o;
  if (isFullscreen()) lockOrientation();
}

/** First touch anywhere re-enters fullscreen (e.g. after returning to a resumed session). */
export function armFullscreenOnFirstTouch() {
  if (!reqFs) return;
  const h = () => {
    enterFullscreen();
    removeEventListener('pointerup', h, true);
  };
  addEventListener('pointerup', h, true);
}
// Android drops fullscreen on some gestures; ask again on the next tap.
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) armFullscreenOnFirstTouch();
});

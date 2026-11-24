// Photo framing: shows the chosen picture under a circular frame; the player drags to position
// and pinches / uses the slider to zoom. Returns a small square JPEG (the circle is applied by CSS
// everywhere the avatar is shown), so uploads are ~10 KB and cost the Pi nothing to serve.
//
//   const blob = await cropPhoto(file);   // Blob | null (cancelled) – throws if the file can't be decoded
const OUT = 192; // output size in px (shown at up to ~100 px on a 1080p TV -> crisp on 2x screens too)
const ZOOM_MAX = 4;

export function cropPhoto(file) {
  const $ = (id) => document.getElementById(id);
  const modal = $('crop'), stage = $('stage'), img = $('cropImg'), zoomEl = $('zoom');

  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const done = (v, err) => {
      URL.revokeObjectURL(url);
      modal.hidden = true;
      img.removeAttribute('src');
      stage.removeEventListener('pointerdown', down);
      stage.removeEventListener('wheel', wheel);
      zoomEl.removeEventListener('input', onZoom);
      $('cropSave').onclick = $('cropCancel').onclick = null;
      window.__cropCancel = null;
      err ? reject(err) : resolve(v);
    };

    let S = 0, nw = 0, nh = 0, zoom = 1, tx = 0, ty = 0;
    const scale = () => (S / Math.min(nw, nh)) * zoom; // zoom 1 = picture just covers the frame

    function layout() {
      const sc = scale(), w = nw * sc, h = nh * sc;
      tx = Math.min(0, Math.max(S - w, tx)); // never show empty space inside the frame
      ty = Math.min(0, Math.max(S - h, ty));
      img.style.width = w + 'px';
      img.style.height = h + 'px';
      img.style.transform = `translate(${tx}px,${ty}px)`;
    }
    function setZoom(z) {
      const old = scale();
      const cx = (S / 2 - tx) / old, cy = (S / 2 - ty) / old; // picture point under the frame centre
      zoom = Math.min(ZOOM_MAX, Math.max(1, z));
      zoomEl.value = zoom;
      const sc = scale();
      tx = S / 2 - cx * sc;
      ty = S / 2 - cy * sc;
      layout();
    }

    // --- gestures: one finger pans, two fingers pinch ---
    const pts = new Map();
    let pinch0 = 0, zoom0 = 1;
    function down(e) {
      stage.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch0 = Math.hypot(a.x - b.x, a.y - b.y);
        zoom0 = zoom;
      }
      stage.addEventListener('pointermove', move);
      stage.addEventListener('pointerup', up);
      stage.addEventListener('pointercancel', up);
    }
    function move(e) {
      const p = pts.get(e.pointerId);
      if (!p) return;
      if (pts.size === 1) {
        tx += e.clientX - p.x;
        ty += e.clientY - p.y;
        layout();
      }
      p.x = e.clientX;
      p.y = e.clientY;
      if (pts.size === 2 && pinch0) {
        const [a, b] = [...pts.values()];
        setZoom(zoom0 * (Math.hypot(a.x - b.x, a.y - b.y) / pinch0));
      }
    }
    function up(e) {
      pts.delete(e.pointerId);
      if (!pts.size) {
        stage.removeEventListener('pointermove', move);
        stage.removeEventListener('pointerup', up);
        stage.removeEventListener('pointercancel', up);
      }
    }
    const wheel = (e) => (e.preventDefault(), setZoom(zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08)));
    const onZoom = () => setZoom(Number(zoomEl.value));
    stage.addEventListener('pointerdown', down);
    stage.addEventListener('wheel', wheel, { passive: false });
    zoomEl.addEventListener('input', onZoom);

    $('cropCancel').onclick = () => done(null);
    window.__cropCancel = () => done(null); // lets the shell close the dialog if a game starts meanwhile
    $('cropSave').onclick = () => {
      const sc = scale();
      const c = document.createElement('canvas');
      c.width = c.height = OUT;
      const g = c.getContext('2d');
      g.fillStyle = '#222';
      g.fillRect(0, 0, OUT, OUT);
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, -tx / sc, -ty / sc, S / sc, S / sc, 0, 0, OUT, OUT);
      c.toBlob((b) => (b ? done(b) : done(null, new Error('encode failed'))), 'image/jpeg', 0.85);
    };

    img.onload = () => {
      nw = img.naturalWidth;
      nh = img.naturalHeight;
      modal.hidden = false; // show first so the stage has a size
      S = stage.clientWidth;
      zoom = 1;
      zoomEl.value = 1;
      tx = (S - nw * scale()) / 2; // start centred
      ty = (S - nh * scale()) / 2;
      layout();
    };
    img.onerror = () => done(null, new Error('unreadable'));
    img.src = url;
  });
}

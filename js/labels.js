// HTML labels pinned to 3D points, with simple priority-based collision hiding.
import * as THREE from 'three';

const v = new THREE.Vector3();

export class Labels {
  constructor(root, camera) {
    this.root = root; this.camera = camera; this.items = []; this.filter = null; this.flat = false; this.measured = false;
  }
  add({ text, cat, tier, x, y, z, onClick, cls = '', icon = '' }) {
    const el = document.createElement('button');
    el.className = `lbl t${Math.min(tier, 4)} ${cls}`;
    el.type = 'button';
    el.innerHTML = (icon ? `<b>${icon}</b>` : `<i style="background:${cat}"></i>`) + `<span></span>`;
    el.lastChild.textContent = text;
    el.addEventListener('click', (e) => { e.stopPropagation(); onClick && onClick(); });
    this.root.appendChild(el);
    const it = { el, pos: new THREE.Vector3(x, y, z), tier, w: 0, h: 0, shown: false, data: null, hidden: false };
    this.items.push(it);
    this.measured = false;
    return it;
  }
  remove(it) { it.el.remove(); this.items = this.items.filter((i) => i !== it); }
  clear(cls) { for (const it of this.items.slice()) if (!cls || it.el.classList.contains(cls)) this.remove(it); }
  measure() {
    for (const it of this.items) { it.w = it.el.offsetWidth || 80; it.h = it.el.offsetHeight || 24; }
    this.measured = true;
  }
  update(width, height, maxDist = Infinity) {
    if (!this.measured) this.measure();
    const cam = this.camera, cand = [];
    for (const it of this.items) {
      if (it.hidden || (this.filter && !this.filter(it))) { this.hide(it); continue; }
      const d = cam.position.distanceTo(it.pos);
      const lim = it.tier <= 0 ? Infinity : it.tier === 1 ? 4200 : it.tier === 2 ? 1500 : it.tier === 3 ? 750 : 420;
      if (d > Math.min(lim * (this.flat ? 1.6 : 1), maxDist)) { this.hide(it); continue; }
      v.copy(it.pos);
      if (this.flat) v.y = 2;
      v.project(cam);
      if (v.z > 1 || v.x < -1.1 || v.x > 1.1 || v.y < -1.1 || v.y > 1.1) { this.hide(it); continue; }
      cand.push([it, (v.x + 1) / 2 * width, (1 - v.y) / 2 * height, d]);
    }
    cand.sort((a, b) => (a[0].tier - b[0].tier) || (a[3] - b[3]));
    const placed = [];
    for (const [it, x, y] of cand) {
      const r = [x - it.w / 2 - 3, y - it.h - 9, x + it.w / 2 + 3, y - 5];
      let hit = false;
      if (it.tier > 0) for (const p of placed) if (r[0] < p[2] && r[2] > p[0] && r[1] < p[3] && r[3] > p[1]) { hit = true; break; }
      if (hit) { this.hide(it); continue; }
      placed.push(r);
      it.el.style.transform = `translate3d(${(x - it.w / 2).toFixed(1)}px,${(y - it.h - 7).toFixed(1)}px,0)`;
      if (!it.shown) { it.el.classList.add('show'); it.shown = true; }
    }
  }
  hide(it) { if (it.shown) { it.el.classList.remove('show'); it.shown = false; } }
}

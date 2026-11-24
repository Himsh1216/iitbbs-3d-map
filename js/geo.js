// Local flat projection around the campus centre, plus small geometry helpers.
// x = metres east, z = metres south (three.js: y is up, north is -z).

export const ORIGIN = { lat: 20.14797, lon: 85.67007 };
const phi = ORIGIN.lat * Math.PI / 180;
const KY = 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi);
const KX = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi) + 0.118 * Math.cos(5 * phi);

export const project = (lat, lon) => [(lon - ORIGIN.lon) * KX, (ORIGIN.lat - lat) * KY];
export const unproject = (x, z) => ({ lat: ORIGIN.lat - z / KY, lon: ORIGIN.lon + x / KX });

// rings are flat arrays [x0,z0,x1,z1,...] without the closing point
export function signedArea(r) {
  let a = 0;
  for (let i = 0, n = r.length; i < n; i += 2) {
    const j = (i + 2) % n;
    a += r[i] * r[j + 1] - r[j] * r[i + 1];
  }
  return a / 2;
}

export function centroid(r) {
  let a = 0, cx = 0, cz = 0;
  for (let i = 0, n = r.length; i < n; i += 2) {
    const j = (i + 2) % n;
    const f = r[i] * r[j + 1] - r[j] * r[i + 1];
    a += f; cx += (r[i] + r[j]) * f; cz += (r[i + 1] + r[j + 1]) * f;
  }
  if (Math.abs(a) < 1e-6) {
    let sx = 0, sz = 0;
    for (let i = 0; i < r.length; i += 2) { sx += r[i]; sz += r[i + 1]; }
    return [sx / (r.length / 2), sz / (r.length / 2)];
  }
  return [cx / (3 * a), cz / (3 * a)];
}

export function pointInRing(x, z, r) {
  let inside = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const xi = r[i], zi = r[i + 1], xj = r[j], zj = r[j + 1];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInPoly(x, z, rings) {
  if (!pointInRing(x, z, rings[0])) return false;
  for (let k = 1; k < rings.length; k++) if (pointInRing(x, z, rings[k])) return false;
  return true;
}

export function bbox(r, b = [Infinity, Infinity, -Infinity, -Infinity]) {
  for (let i = 0; i < r.length; i += 2) {
    if (r[i] < b[0]) b[0] = r[i];
    if (r[i + 1] < b[1]) b[1] = r[i + 1];
    if (r[i] > b[2]) b[2] = r[i];
    if (r[i + 1] > b[3]) b[3] = r[i + 1];
  }
  return b;
}

// closest point on segment ab to p; returns [x, z, t, dist2]
export function closestOnSeg(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz;
  let t = l2 ? ((px - ax) * dx + (pz - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = ax + dx * t, z = az + dz * t;
  return [x, z, t, (px - x) ** 2 + (pz - z) ** 2];
}

export function distToRing(px, pz, r) {
  let best = Infinity, bx = 0, bz = 0;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const c = closestOnSeg(px, pz, r[j], r[j + 1], r[i], r[i + 1]);
    if (c[3] < best) { best = c[3]; bx = c[0]; bz = c[1]; }
  }
  return [Math.sqrt(best), bx, bz];
}

export function polylineLength(p) {
  let s = 0;
  for (let i = 2; i < p.length; i += 2) s += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  return s;
}

// Douglas-Peucker on a flat [x,z,...] array
export function simplify(p, tol) {
  const n = p.length / 2;
  if (n < 3) return p.slice();
  const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  const t2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    let md = -1, mi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = closestOnSeg(p[2 * i], p[2 * i + 1], p[2 * a], p[2 * a + 1], p[2 * b], p[2 * b + 1])[3];
      if (d > md) { md = d; mi = i; }
    }
    if (md > t2) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(p[2 * i], p[2 * i + 1]);
  return out;
}

// deterministic pseudo random
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// uniform grid for fast "what is near here" lookups
export class Grid {
  constructor(cell = 40) { this.cell = cell; this.map = new Map(); }
  key(ix, iz) { return ix * 73856093 ^ iz * 19349663; }
  insertBox(b, item) {
    const c = this.cell;
    for (let ix = Math.floor(b[0] / c); ix <= Math.floor(b[2] / c); ix++)
      for (let iz = Math.floor(b[1] / c); iz <= Math.floor(b[3] / c); iz++) {
        const k = this.key(ix, iz);
        let a = this.map.get(k);
        if (!a) this.map.set(k, a = []);
        a.push(item);
      }
  }
  query(x, z) { return this.map.get(this.key(Math.floor(x / this.cell), Math.floor(z / this.cell))) || []; }
  queryBox(b) {
    const c = this.cell, out = new Set();
    for (let ix = Math.floor(b[0] / c); ix <= Math.floor(b[2] / c); ix++)
      for (let iz = Math.floor(b[1] / c); iz <= Math.floor(b[3] / c); iz++)
        for (const it of this.map.get(this.key(ix, iz)) || []) out.add(it);
    return out;
  }
}

export const fmtDist = (m) => m < 950 ? `${Math.round(m / 10) * 10 || Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`;
export const fmtMin = (s) => s < 60 ? '<1 min' : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;

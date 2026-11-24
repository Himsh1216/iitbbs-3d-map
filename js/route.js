// Shortest walking / cycling routes on the campus network, with turn-by-turn steps.
import { snap, accessPoint } from './osm.js';
import { distToRing } from './geo.js';

const COST = {
  walk: { steps: 1.15, major: 1.1, track: 1.05, corridor: 1 },
  cycle: { steps: 8, foot: 1.25, path: 1.3, corridor: 3, track: 1.15 },
};
export const SPEED = { walk: 1.3, cycle: 4.2 }; // m/s

class Heap {
  constructor() { this.a = []; }
  push(n, f) {
    const a = this.a; a.push([n, f]);
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p][1] <= a[i][1]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && a[l][1] < a[m][1]) m = l;
        if (r < a.length && a[r][1] < a[m][1]) m = r;
        if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
  get size() { return this.a.length; }
}

// endpoint for a place, building or bare position
export function endpoint(model, thing) {
  const nav = model.nav;
  if (thing.bid !== undefined && model.buildings[thing.bid]) {
    const b = model.buildings[thing.bid];
    const s = accessPoint(nav, b);
    if (s) {
      if (s.wx === undefined) { const [, wx, wz] = distToRing(s.x, s.z, b.rings[0]); s.wx = wx; s.wz = wz; }
      return { s, x: s.x, z: s.z, wall: { x: s.wx, z: s.wz }, label: thing.name || b.name };
    }
  }
  const s = snap(nav, thing.x, thing.z);
  if (!s) return null;
  return { s, x: s.x, z: s.z, wall: s.d > 2 ? { x: thing.x, z: thing.z } : null, label: thing.name || '' };
}

export function findRoute(model, from, to, mode = 'walk') {
  const nav = model.nav, X = nav.X, Z = nav.Z, N = X.length;
  const A = endpoint(model, from), B = endpoint(model, to);
  if (!A || !B) return null;
  const cost = COST[mode] || COST.walk;
  const roads = model.roads;
  const w = (len, ri) => len * (ri >= 0 ? (cost[roads[ri].kind] || 1) : 1.2);
  const S = N, T = N + 1;
  const g = new Float64Array(N + 2).fill(Infinity);
  const prev = new Int32Array(N + 2).fill(-1);
  const prevRoad = new Int32Array(N + 2).fill(-1);
  const done = new Uint8Array(N + 2);
  const h = (i) => Math.hypot((i === S ? A.x : i === T ? B.x : X[i]) - B.x, (i === S ? A.z : i === T ? B.z : Z[i]) - B.z) * 0.95;
  const eA = nav.edges[A.s.e], eB = nav.edges[B.s.e];
  const roadA = eA[3], roadB = eB[3];
  const into = new Map(); // graph node -> cost to T
  into.set(B.s.a, Math.hypot(X[B.s.a] - B.x, Z[B.s.a] - B.z));
  into.set(B.s.b, Math.min(into.get(B.s.b) ?? Infinity, Math.hypot(X[B.s.b] - B.x, Z[B.s.b] - B.z)));
  const heap = new Heap();
  g[S] = 0; heap.push(S, h(S));
  if (A.s.e === B.s.e) { // same street segment: walk straight along it
    g[T] = w(Math.hypot(A.x - B.x, A.z - B.z), roadA); prev[T] = S; prevRoad[T] = roadA;
  }
  while (heap.size) {
    const [u] = heap.pop();
    if (done[u]) continue;
    done[u] = 1;
    if (u === T) break;
    const nbrs = u === S
      ? [[A.s.a, Math.hypot(X[A.s.a] - A.x, Z[A.s.a] - A.z), roadA], [A.s.b, Math.hypot(X[A.s.b] - A.x, Z[A.s.b] - A.z), roadA]]
      : nav.adj[u];
    for (const [v, len, ri] of nbrs) {
      const ng = g[u] + w(len, ri);
      if (ng < g[v]) { g[v] = ng; prev[v] = u; prevRoad[v] = ri; heap.push(v, ng + h(v)); }
    }
    if (u !== S && into.has(u)) {
      const ng = g[u] + w(into.get(u), roadB);
      if (ng < g[T]) { g[T] = ng; prev[T] = u; prevRoad[T] = roadB; heap.push(T, ng); }
    }
  }
  if (!isFinite(g[T])) return null;
  const seq = [];
  for (let v = T; v !== -1; v = prev[v]) seq.push(v);
  seq.reverse();
  const pts = [], roadOf = [];
  const push = (x, z, r) => {
    const n = pts.length;
    if (n && Math.abs(pts[n - 2] - x) < 0.01 && Math.abs(pts[n - 1] - z) < 0.01) return;
    pts.push(x, z); roadOf.push(r);
  };
  if (A.wall) push(A.wall.x, A.wall.z, -2);
  for (const v of seq) {
    const r = prevRoad[v];
    if (v === S) push(A.x, A.z, roadA);
    else if (v === T) push(B.x, B.z, r);
    else push(X[v], Z[v], r);
  }
  if (B.wall) push(B.wall.x, B.wall.z, -2);
  let dist = 0;
  const cum = [0];
  for (let i = 2; i < pts.length; i += 2) { dist += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]); cum.push(dist); }
  const route = { pts, cum, dist, mode, time: dist / SPEED[mode], from: A, to: B, fromName: from.name || A.label, toName: to.name || B.label };
  route.steps = steps(model, route, roadOf);
  return route;
}

const bearing = (dx, dz) => (Math.atan2(dx, -dz) * 180 / Math.PI + 360) % 360;
const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

function landmark(model, x, z, skip) {
  let best = null, bd = 75;
  for (const b of model.bGrid.queryBox([x - 75, z - 75, x + 75, z + 75])) {
    if (!b.name || b.name === skip) continue;
    const d = Math.hypot(b.cx - x, b.cz - z) - Math.sqrt(b.area) / 2;
    if (d < bd) { bd = d; best = b; }
  }
  return best ? (best.short || best.label || best.name) : '';
}

// bearing over a window of ~w metres to ignore tiny kinks
function dirAt(route, i, sign, w = 9) {
  const p = route.pts, n = p.length / 2;
  let j = i;
  while (j + sign >= 0 && j + sign < n && Math.abs(route.cum[j + sign] - route.cum[i]) < w) j += sign;
  if (j === i) j = Math.min(n - 1, Math.max(0, i + sign));
  return sign > 0 ? bearing(p[2 * j] - p[2 * i], p[2 * j + 1] - p[2 * i + 1]) : bearing(p[2 * i] - p[2 * j], p[2 * i + 1] - p[2 * j + 1]);
}

function steps(model, route, roadOf) {
  const p = route.pts, n = p.length / 2, out = [];
  if (n < 2) return out;
  const b0 = dirAt(route, 0, 1);
  out.push({ icon: 'start', i: 0, text: `Head ${COMPASS[Math.round(b0 / 45) % 8]}` + (route.fromName ? ` from ${route.fromName}` : '') });
  let lastTurn = -1e9;
  for (let i = 1; i < n - 1; i++) {
    const segIn = route.cum[i] - route.cum[i - 1];
    if (segIn < 0.5 && roadOf[i] === roadOf[i + 1]) continue;
    const a = dirAt(route, i, -1), b = dirAt(route, i, 1);
    let turn = ((b - a + 540) % 360) - 180;
    if (Math.abs(turn) < 33) continue;
    if (route.cum[i] - lastTurn < 10) continue;
    const side = turn > 0 ? 'right' : 'left';
    const kind = Math.abs(turn) < 60 ? 'slight' : Math.abs(turn) < 140 ? 'turn' : 'sharp';
    const lm = landmark(model, p[2 * i], p[2 * i + 1], route.toName);
    const verb = kind === 'slight' ? `Bear ${side}` : kind === 'sharp' ? `Sharp ${side}` : `Turn ${side}`;
    out.push({ icon: side + (kind === 'turn' ? '' : '-' + kind), i, text: verb + (lm ? ` near ${lm}` : '') });
    lastTurn = route.cum[i];
  }
  out.push({ icon: 'arrive', i: n - 1, text: `Arrive at ${route.toName || 'destination'}` });
  for (let k = 0; k < out.length; k++) {
    const next = out[k + 1];
    out[k].d = next ? route.cum[next.i] - route.cum[out[k].i] : 0;
    out[k].at = route.cum[out[k].i];
  }
  return out;
}

// position + heading at distance s along the route
export function along(route, s) {
  const p = route.pts, c = route.cum;
  s = Math.max(0, Math.min(route.dist, s));
  let lo = 0, hi = c.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m] <= s) lo = m; else hi = m; }
  const seg = c[hi] - c[lo] || 1, t = (s - c[lo]) / seg;
  const x = p[2 * lo] + (p[2 * hi] - p[2 * lo]) * t, z = p[2 * lo + 1] + (p[2 * hi + 1] - p[2 * lo + 1]) * t;
  return { x, z, heading: Math.atan2(p[2 * hi] - p[2 * lo], p[2 * hi + 1] - p[2 * lo + 1]), i: lo };
}

// distance along the route of the point closest to (x, z), and how far off it is
export function progress(route, x, z) {
  const p = route.pts;
  let best = Infinity, bs = 0;
  for (let i = 2; i < p.length; i += 2) {
    const ax = p[i - 2], az = p[i - 1], bx = p[i], bz = p[i + 1];
    const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
    let t = ((x - ax) * dx + (z - az) * dz) / l2; t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(ax + dx * t - x, az + dz * t - z);
    if (d < best) { best = d; bs = route.cum[i / 2 - 1] + t * Math.sqrt(l2); }
  }
  return { s: bs, off: best };
}

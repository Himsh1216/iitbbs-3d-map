// Everything drawn in 3D: ground, areas, roads, buildings, trees, lamps, sky, light.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { signedArea, centroid, simplify, pointInPoly, rng, Grid, bbox, closestOnSeg } from './geo.js';
import { CATS } from './osm.js';

const C = (s) => new THREE.Color().setStyle(s);

const WALL = { academic: '#efe1cc', hostel: '#f2e7d4', residential: '#ece4d6', admin: '#f4ead9', civic: '#efe6d8', food: '#f0dcc0', shop: '#eedbc6', health: '#f3ece4', guest: '#f1e2d3', sports: '#e8e1d2', worship: '#f0d9b5', other: '#e6dfd3' };
const ROOF = { academic: '#a8957c', hostel: '#9f8f7a', residential: '#a29a8c', other: '#aea596' };
const AREA = {
  forest: ['#5d8a4a', 0.12], scrub: ['#89a062', 0.12], farm: ['#b4bd78', 0.12], construction: ['#c8a67c', 0.14], sand: ['#dccb9c', 0.14],
  wetland: ['#7d9f86', 0.16], grass: ['#8dbb5d', 0.18], sports: ['#9cc576', 0.22], track: ['#b45a43', 0.24], pitch: ['#74b354', 0.26],
  parking: ['#a3a39d', 0.3], water: ['#3f86b8', 0.32],
};
const PITCH = { cricket: '#8bbd5c', soccer: '#5eac4b', field_hockey: '#3f9c8f', tennis: '#c46a45', basketball: '#c98a4b', volleyball: '#d6b679', badminton: '#4f946a', athletics: '#b45a43' };
const ROADS = {
  major: ['#565a61', 0.62], minor: ['#5f636a', 0.58], service: ['#6a6e74', 0.55], foot: ['#cbb89c', 0.5], path: ['#b89d78', 0.48],
  cycle: ['#7e9b84', 0.5], steps: ['#b2a28a', 0.5], track: ['#a88d6a', 0.46], corridor: ['#c9bba6', 0.5],
};

// ---------------------------------------------------------------- textures
function noiseTexture() {
  const s = 256, c = document.createElement('canvas'); c.width = c.height = s;
  const g = c.getContext('2d'), img = g.createImageData(s, s), r = rng(7);
  const base = new Float32Array(s * s).map(() => r());
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    let v = 0, w = 0;
    for (let k = 1; k <= 3; k++) { const q = (((y >> k) * 37 + (x >> k) * 101) % (s * s)); v += base[q] * k; w += k; }
    v = 0.86 + 0.2 * (v / w) + 0.06 * (r() - 0.5);
    const i = (y * s + x) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.min(255, v * 230); img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
function glowTexture() {
  const s = 64, c = document.createElement('canvas'); c.width = c.height = s;
  const g = c.getContext('2d'), grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grd.addColorStop(0, 'rgba(255,240,210,1)'); grd.addColorStop(0.25, 'rgba(255,200,120,.55)'); grd.addColorStop(1, 'rgba(255,170,80,0)');
  g.fillStyle = grd; g.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

// ---------------------------------------------------------------- geometry helpers
class Buf {
  constructor(extra = {}) { this.p = []; this.n = []; this.c = []; this.uv = []; this.x = {}; for (const k in extra) this.x[k] = { size: extra[k], a: [] }; }
  v(x, y, z, nx, ny, nz, col, uvx = x / 30, uvy = z / 30, ex = {}) {
    this.p.push(x, y, z); this.n.push(nx, ny, nz); this.c.push(col.r, col.g, col.b); this.uv.push(uvx, uvy);
    for (const k in this.x) { const e = ex[k]; if (Array.isArray(e)) this.x[k].a.push(...e); else this.x[k].a.push(e ?? 0); }
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    for (const k in this.x) g.setAttribute(k, new THREE.Float32BufferAttribute(this.x[k].a, this.x[k].size));
    g.computeBoundingSphere();
    return g;
  }
}

function triangulate(rings) {
  const contour = [], holes = [], all = [];
  const toV = (r) => { const a = []; for (let i = 0; i < r.length; i += 2) a.push(new THREE.Vector2(r[i], r[i + 1])); return a; };
  const c0 = toV(rings[0]); contour.push(...c0); all.push(...c0);
  for (let k = 1; k < rings.length; k++) { const h = toV(rings[k]); holes.push(h); all.push(...h); }
  let faces = [];
  try { faces = THREE.ShapeUtils.triangulateShape(contour, holes); } catch { faces = []; }
  return { pts: all, faces };
}

// flat polygon facing up at height y
function flatPoly(buf, rings, y, col, ex) {
  const { pts, faces } = triangulate(rings);
  for (const f of faces) {
    let [a, b, c] = f;
    const A = pts[a], B = pts[b], Cc = pts[c];
    if ((B.x - A.x) * (Cc.y - A.y) - (Cc.x - A.x) * (B.y - A.y) > 0) [b, c] = [c, b];
    for (const i of [a, b, c]) buf.v(pts[i].x, y, pts[i].y, 0, 1, 0, col, pts[i].x / 30, pts[i].y / 30, ex);
  }
}

function ribbon(buf, pts, width, yAt, col, round = true) {
  const n = pts.length / 2;
  if (n < 2) return;
  const hw = width / 2;
  const L = [], R = [];
  for (let i = 0; i < n; i++) {
    const x = pts[2 * i], z = pts[2 * i + 1];
    let dx = 0, dz = 0;
    if (i > 0) { const ax = x - pts[2 * i - 2], az = z - pts[2 * i - 1], l = Math.hypot(ax, az) || 1; dx += ax / l; dz += az / l; }
    if (i < n - 1) { const bx = pts[2 * i + 2] - x, bz = pts[2 * i + 3] - z, l = Math.hypot(bx, bz) || 1; dx += bx / l; dz += bz / l; }
    const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    let m = hw;
    if (i > 0 && i < n - 1) {
      const ax = x - pts[2 * i - 2], az = z - pts[2 * i - 1], la = Math.hypot(ax, az) || 1;
      const cos = Math.abs((ax / la) * dx + (az / la) * dz);
      m = hw / Math.max(cos, 0.45);
    }
    L.push([x - dz * m, z + dx * m]); R.push([x + dz * m, z - dx * m]);
  }
  let s = 0;
  for (let i = 0; i < n - 1; i++) {
    const y0 = yAt(i), y1 = yAt(i + 1);
    const seg = Math.hypot(pts[2 * i + 2] - pts[2 * i], pts[2 * i + 3] - pts[2 * i + 1]);
    const q = [[L[i], y0, s], [R[i], y0, s], [R[i + 1], y1, s + seg], [L[i + 1], y1, s + seg]];
    s += seg;
    const tri = [q[0], q[2], q[1], q[0], q[3], q[2]];
    for (const [p, y, u] of tri) buf.v(p[0], y, p[1], 0, 1, 0, col, p[0] / 30, p[1] / 30, { aU: u });
  }
  if (round && width > 3) {
    for (let i = 0; i < n; i++) {
      if (i > 0 && i < n - 1) {
        const ax = pts[2 * i] - pts[2 * i - 2], az = pts[2 * i + 1] - pts[2 * i - 1];
        const bx = pts[2 * i + 2] - pts[2 * i], bz = pts[2 * i + 3] - pts[2 * i + 1];
        const cos = (ax * bx + az * bz) / ((Math.hypot(ax, az) * Math.hypot(bx, bz)) || 1);
        if (cos > 0.85) continue;
      }
      const cx = pts[2 * i], cz = pts[2 * i + 1], y = yAt(i) - 0.005, seg = 10;
      for (let k = 0; k < seg; k++) {
        const a0 = (k / seg) * Math.PI * 2, a1 = ((k + 1) / seg) * Math.PI * 2;
        buf.v(cx, y, cz, 0, 1, 0, col, cx / 30, cz / 30, { aU: 0 });
        buf.v(cx + Math.cos(a1) * hw, y, cz + Math.sin(a1) * hw, 0, 1, 0, col, 0, 0, { aU: 0 });
        buf.v(cx + Math.cos(a0) * hw, y, cz + Math.sin(a0) * hw, 0, 1, 0, col, 0, 0, { aU: 0 });
      }
    }
  }
}

// vertical strip (walls, fences) along a polyline, both sides
function fence(buf, pts, h, col, y0 = 0) {
  for (let i = 2; i < pts.length; i += 2) {
    const ax = pts[i - 2], az = pts[i - 1], bx = pts[i], bz = pts[i + 1];
    const l = Math.hypot(bx - ax, bz - az); if (l < 0.01) continue;
    const nx = (bz - az) / l, nz = -(bx - ax) / l;
    for (const s of [1, -1]) {
      const q = [[ax, y0, az], [bx, y0, bz], [bx, y0 + h, bz], [ax, y0 + h, az]];
      const order = s > 0 ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3];
      for (const k of order) buf.v(q[k][0] + nx * 0.06 * s, q[k][1], q[k][2] + nz * 0.06 * s, nx * s, 0, nz * s, col);
    }
  }
}

// ---------------------------------------------------------------- materials with per-building state
function stateTexture(n) {
  const w = 256, h = Math.max(1, Math.ceil(n / w));
  const data = new Uint8Array(w * h * 4);
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  tex.needsUpdate = true;
  return tex;
}

function buildingMaterial(kind, shared) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: kind === 'wall' ? 0.82 : 0.9, metalness: 0 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uState = shared.uState; sh.uniforms.uNight = shared.uNight; sh.uniforms.uAccent = shared.uAccent; sh.uniforms.uWin = shared.uWin;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\nattribute float aBid;\nvarying float vBid;\n${kind === 'wall' ? 'attribute vec4 aWall;\nvarying vec4 vWall;' : ''}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvBid = aBid;\n${kind === 'wall' ? 'vWall = aWall;' : ''}`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2D uState; uniform float uNight; uniform vec3 uAccent; uniform float uWin;
varying float vBid; ${kind === 'wall' ? 'varying vec4 vWall;' : ''}
float hash13(vec3 p3){ p3 = fract(p3 * .1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
int bi = int(vBid + 0.5);
vec4 st = texelFetch(uState, ivec2(bi % 256, bi / 256), 0);
float lit = 0.0;
${kind === 'wall' ? `
if (vWall.z > 0.5 && uWin > 0.5) {
  vec2 g = vec2(vWall.x / 3.4, vWall.y / vWall.z);
  vec2 cell = floor(g); vec2 f = fract(g);
  vec2 aa = fwidth(g) * 1.1;
  float wx = smoothstep(0.22 - aa.x, 0.22 + aa.x, f.x) * (1.0 - smoothstep(0.78 - aa.x, 0.78 + aa.x, f.x));
  float wy = smoothstep(0.32 - aa.y, 0.32 + aa.y, f.y) * (1.0 - smoothstep(0.82 - aa.y, 0.82 + aa.y, f.y));
  float win = wx * wy * step(vWall.y + vWall.z * 0.3, vWall.w) * (1.0 - smoothstep(0.2, 0.55, max(aa.x, aa.y)));
  lit = win * step(0.5, hash13(vec3(cell, vBid)));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.18, 0.24, 0.3), win * 0.72);
}` : ''}
float lum = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(lum * 0.45 + 0.42), st.g * 0.88);
diffuseColor.rgb = mix(diffuseColor.rgb, uAccent, st.r * 0.42);
diffuseColor.rgb += st.b * 0.07;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance += lit * uNight * vec3(1.0, 0.74, 0.42) * (1.0 - st.g * 0.9);
totalEmissiveRadiance += uAccent * st.r * (0.18 + 0.3 * uNight);`);
  };
  m.customProgramCacheKey = () => 'bld-' + kind;
  return m;
}

// ---------------------------------------------------------------- buildings
function buildingsMeshes(model, shared) {
  const W = new Buf({ aWall: 4, aBid: 1 }), R = new Buf({ aBid: 1 });
  const tmp = new THREE.Color();
  for (const b of model.buildings) {
    const wallCol = C(b.wall || WALL[b.cat] || WALL.other);
    const hsl = {}; wallCol.getHSL(hsl);
    if (hsl.l > 0.86) wallCol.setHSL(hsl.h, hsl.s, 0.86);
    if (b.extra) wallCol.lerp(C('#d9d4ca'), 0.4);
    if (!b.inside) wallCol.lerp(C('#cfcac0'), 0.5);
    const roofCol = C(b.roof || ROOF[b.cat] || ROOF.other);
    const ex = { aBid: b.bid };
    let shape = b.roofShape;
    const outer = b.rings[0];
    let rect = null;
    if (['gabled', 'hipped', 'pyramidal'].includes(shape)) {
      const s = simplify([...outer, outer[0], outer[1]], 0.6); s.length -= 2;
      if (s.length === 8 || shape === 'pyramidal') rect = s; else shape = 'flat';
    }
    let roofH = 0;
    if (shape === 'gabled' || shape === 'hipped') {
      const e0 = Math.hypot(rect[2] - rect[0], rect[3] - rect[1]), e1 = Math.hypot(rect[4] - rect[2], rect[5] - rect[3]);
      roofH = b.roofH || Math.min(4, Math.min(e0, e1) * 0.35);
    } else if (shape === 'pyramidal') roofH = b.roofH || Math.min(6, Math.sqrt(b.area) * 0.3);
    else if (shape === 'dome') roofH = b.roofH || Math.sqrt(b.area / Math.PI) * 0.7;
    const base = b.roofOnly ? Math.max(b.minH, b.h - 0.6) : b.minH;
    const top = Math.max(base + 1, b.h - (shape === 'dome' ? 0 : roofH));
    const wallH = top - base;
    for (const ring of b.rings) {
      let u = 0;
      const n = ring.length / 2;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const x0 = ring[2 * i], z0 = ring[2 * i + 1], x1 = ring[2 * j], z1 = ring[2 * j + 1];
        const len = Math.hypot(x1 - x0, z1 - z0);
        if (len < 0.05) continue;
        const nx = (z1 - z0) / len, nz = -(x1 - x0) / len;
        const fh = b.windows && len > 2.4 ? b.floorH : 0;
        const q = [[x0, base, z0, u, 0], [x1, base, z1, u + len, 0], [x1, top, z1, u + len, wallH], [x0, top, z0, u, wallH]];
        for (const k of [0, 2, 1, 0, 3, 2]) W.v(q[k][0], q[k][1], q[k][2], nx, 0, nz, wallCol, 0, 0, { aBid: b.bid, aWall: [q[k][3], q[k][4], fh, wallH] });
        u += len;
      }
    }
    if (shape === 'gabled' || shape === 'hipped') {
      let c = [[rect[0], rect[1]], [rect[2], rect[3]], [rect[4], rect[5]], [rect[6], rect[7]]];
      if (Math.hypot(c[1][0] - c[0][0], c[1][1] - c[0][1]) < Math.hypot(c[2][0] - c[1][0], c[2][1] - c[1][1])) c = [c[1], c[2], c[3], c[0]];
      const mid = (a, d) => [(a[0] + d[0]) / 2, (a[1] + d[1]) / 2];
      let m1 = mid(c[1], c[2]), m3 = mid(c[3], c[0]);
      if (shape === 'hipped') {
        const dx = m1[0] - m3[0], dz = m1[1] - m3[1], l = Math.hypot(dx, dz) || 1, inset = Math.min(l * 0.3, Math.hypot(c[2][0] - c[1][0], c[2][1] - c[1][1]) / 2);
        m1 = [m1[0] - dx / l * inset, m1[1] - dz / l * inset]; m3 = [m3[0] + dx / l * inset, m3[1] + dz / l * inset];
      }
      const T = top + roofH;
      const V = (p, y) => new THREE.Vector3(p[0], y, p[1]);
      const face = (buf, pts, col, ex2, up) => {
        const [a, bq, cq] = pts;
        const nrm = new THREE.Vector3().subVectors(bq, a).cross(new THREE.Vector3().subVectors(cq, a)).normalize();
        let order = [a, bq, cq];
        if (up ? nrm.y < 0 : nrm.x * (a.x - b.cx) + nrm.z * (a.z - b.cz) < 0) { order = [a, cq, bq]; nrm.negate(); }
        for (const p of order) buf.v(p.x, p.y, p.z, nrm.x, nrm.y, nrm.z, col, 0, 0, ex2);
      };
      const ra = V(m3, T), rb = V(m1, T);
      face(R, [V(c[0], top), V(c[1], top), rb], roofCol, ex, true); face(R, [V(c[0], top), rb, ra], roofCol, ex, true);
      face(R, [V(c[2], top), V(c[3], top), ra], roofCol, ex, true); face(R, [V(c[2], top), ra, rb], roofCol, ex, true);
      const gableTo = shape === 'gabled' ? W : R, gcol = shape === 'gabled' ? wallCol : roofCol;
      const gex = shape === 'gabled' ? { aBid: b.bid, aWall: [0, 0, 0, 0] } : ex;
      face(gableTo, [V(c[1], top), V(c[2], top), rb], gcol, gex, shape !== 'gabled');
      face(gableTo, [V(c[3], top), V(c[0], top), ra], gcol, gex, shape !== 'gabled');
    } else if (shape === 'pyramidal') {
      const [px, pz] = centroid(rect); const apex = new THREE.Vector3(px, top + roofH, pz);
      for (let i = 0; i < rect.length; i += 2) {
        const j = (i + 2) % rect.length;
        const a = new THREE.Vector3(rect[i], top, rect[i + 1]), d = new THREE.Vector3(rect[j], top, rect[j + 1]);
        const nrm = new THREE.Vector3().subVectors(d, a).cross(new THREE.Vector3().subVectors(apex, a)).normalize();
        const order = nrm.y < 0 ? [a, apex, d] : [a, d, apex]; if (nrm.y < 0) nrm.negate();
        for (const p of order) R.v(p.x, p.y, p.z, nrm.x, nrm.y, nrm.z, roofCol, 0, 0, ex);
      }
    } else {
      flatPoly(R, b.rings, top, roofCol, ex);
      if (shape === 'dome') {
        const r = Math.sqrt(b.area / Math.PI) * 0.92, sphere = new THREE.SphereGeometry(r, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2);
        const pos = sphere.attributes.position, nor = sphere.attributes.normal, idx = sphere.index.array;
        const dcol = tmp.copy(roofCol).lerp(C('#ffffff'), 0.25).clone();
        for (const i of idx) {
          const ny = nor.getY(i) * r / roofH, nl = Math.hypot(nor.getX(i), ny, nor.getZ(i)) || 1;
          R.v(b.cx + pos.getX(i), top + pos.getY(i) * roofH / r, b.cz + pos.getZ(i), nor.getX(i) / nl, ny / nl, nor.getZ(i) / nl, dcol, 0, 0, ex);
        }
        sphere.dispose();
      }
    }
  }
  const walls = new THREE.Mesh(W.geometry(), buildingMaterial('wall', shared));
  const roofs = new THREE.Mesh(R.geometry(), buildingMaterial('roof', shared));
  for (const m of [walls, roofs]) { m.castShadow = true; m.receiveShadow = true; m.userData.pick = 'building'; }
  return [walls, roofs];
}

// ---------------------------------------------------------------- trees and lamps
function scatterTrees(model, count, lite) {
  const r = rng(20081), out = [];
  const roadGrid = new Grid(30);
  model.roads.forEach((rd) => { for (let i = 2; i < rd.pts.length; i += 2) roadGrid.insertBox([Math.min(rd.pts[i - 2], rd.pts[i]) - rd.width, Math.min(rd.pts[i - 1], rd.pts[i + 1]) - rd.width, Math.max(rd.pts[i - 2], rd.pts[i]) + rd.width, Math.max(rd.pts[i - 1], rd.pts[i + 1]) + rd.width], [rd, i]); });
  const areaGrid = new Grid(80);
  model.areas.forEach((a) => areaGrid.insertBox(bbox(a.rings[0]), a));
  const blocked = (x, z, pad = 4) => {
    for (const b of model.bGrid.queryBox([x - pad, z - pad, x + pad, z + pad])) {
      if (x < b.box[0] - pad || x > b.box[2] + pad || z < b.box[1] - pad || z > b.box[3] + pad) continue;
      if (pointInPoly(x, z, b.rings)) return true;
      for (let i = 0; i < b.rings[0].length; i += 2) if (Math.hypot(b.rings[0][i] - x, b.rings[0][i + 1] - z) < pad) return true;
    }
    for (const [rd, i] of roadGrid.query(x, z)) {
      if (closestOnSeg(x, z, rd.pts[i - 2], rd.pts[i - 1], rd.pts[i], rd.pts[i + 1])[3] < (rd.width / 2 + 2.2) ** 2) return true;
    }
    for (const a of areaGrid.query(x, z)) if (['water', 'pitch', 'parking', 'track', 'sports'].includes(a.kind) && pointInPoly(x, z, a.rings)) return true;
    return false;
  };
  const tryAdd = (x, z, kind) => { if (!blocked(x, z)) out.push([x, z, kind, r()]); };
  const dens = lite ? 0.3 : 1;
  for (const a of model.areas) {
    const per = a.kind === 'forest' ? 85 : a.kind === 'scrub' ? 220 : a.kind === 'grass' ? 380 : a.kind === 'farm' ? 900 : 0;
    if (!per) continue;
    const n = Math.min(4000, Math.floor((a.area / per) * dens));
    const bb = bbox(a.rings[0]);
    for (let k = 0, tries = 0; k < n && tries < n * 3; tries++) {
      const x = bb[0] + r() * (bb[2] - bb[0]), z = bb[1] + r() * (bb[3] - bb[1]);
      if (!pointInPoly(x, z, a.rings)) continue;
      k++; tryAdd(x, z, a.kind === 'forest' ? 0 : 1);
    }
  }
  for (const rd of model.roads) {
    if (!['major', 'minor', 'service'].includes(rd.kind) || rd.bridge) continue;
    const step = lite ? 30 : 16;
    let acc = r() * step;
    for (let i = 2; i < rd.pts.length; i += 2) {
      const ax = rd.pts[i - 2], az = rd.pts[i - 1], bx = rd.pts[i], bz = rd.pts[i + 1], l = Math.hypot(bx - ax, bz - az);
      const nx = (bz - az) / (l || 1), nz = -(bx - ax) / (l || 1);
      for (; acc < l; acc += step) {
        const t = acc / l, x = ax + (bx - ax) * t, z = az + (bz - az) * t, off = rd.width / 2 + 3.2 + r() * 1.5;
        if (!model.inCampus(x, z)) continue;
        if (r() < 0.7) tryAdd(x + nx * off, z + nz * off, 2);
        if (r() < 0.7) tryAdd(x - nx * off, z - nz * off, 2);
      }
      acc -= l;
    }
  }
  if (model.boundary) { // the campus is mostly green: scatter on open land too
    const bb = model.ext, area = Math.abs(signedArea(model.boundary));
    const n = Math.floor((area / 1100) * dens);
    for (let k = 0; k < n; k++) {
      const x = bb[0] + r() * (bb[2] - bb[0]), z = bb[1] + r() * (bb[3] - bb[1]);
      if (model.inCampus(x, z)) tryAdd(x, z, 1);
    }
  }
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  if (out.length > count) out.length = count;
  return out;
}

function treesMesh(list) {
  const canopyA = new THREE.IcosahedronGeometry(1, 1); canopyA.scale(1, 0.85, 1);
  const trunk = new THREE.CylinderGeometry(0.22, 0.32, 1, 6); trunk.translate(0, 0.5, 0);
  const canopy = new THREE.InstancedMesh(canopyA, new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true }), list.length);
  const trunks = new THREE.InstancedMesh(trunk, new THREE.MeshStandardMaterial({ color: '#6b513c', roughness: 1 }), list.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), col = new THREE.Color();
  const greens = ['#4f7f3a', '#5c8c40', '#3f6f36', '#6a9447', '#557f45', '#7a9a4c'].map(C);
  list.forEach(([x, z, kind, rr], i) => {
    const big = kind === 0 ? 0.9 + rr * 0.9 : kind === 2 ? 0.8 + rr * 0.5 : 0.6 + rr * 0.8;
    const h = 3 + big * 3.2, cr = 1.8 + big * 1.9;
    s.set(1, h * 0.55, 1); p.set(x, 0, z); m.compose(p, q, s); trunks.setMatrixAt(i, m);
    s.set(cr, cr * (0.85 + rr * 0.35), cr); p.set(x, h * 0.55 + cr * 0.55, z);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rr * 6.28); m.compose(p, q, s); canopy.setMatrixAt(i, m); q.identity();
    col.copy(greens[Math.floor(rr * 977) % greens.length]).offsetHSL(0, 0, (rr - 0.5) * 0.06); canopy.setColorAt(i, col);
  });
  canopy.castShadow = trunks.castShadow = true; canopy.receiveShadow = true;
  canopy.instanceMatrix.needsUpdate = trunks.instanceMatrix.needsUpdate = true;
  return [canopy, trunks];
}

function lamps(model, lite) {
  const pos = [];
  for (const rd of model.roads) {
    if (!['major', 'minor', 'service'].includes(rd.kind)) continue;
    let acc = 8, side = 1;
    for (let i = 2; i < rd.pts.length; i += 2) {
      const ax = rd.pts[i - 2], az = rd.pts[i - 1], bx = rd.pts[i], bz = rd.pts[i + 1], l = Math.hypot(bx - ax, bz - az);
      const nx = (bz - az) / (l || 1), nz = -(bx - ax) / (l || 1);
      for (; acc < l; acc += 34) {
        const t = acc / l, x = ax + (bx - ax) * t, z = az + (bz - az) * t;
        if (!model.inCampus(x, z)) continue;
        const off = (rd.width / 2 + 1) * side; side = -side;
        pos.push([x + nx * off, z + nz * off, rd.bridge ? 6 : 0]);
      }
      acc -= l;
    }
  }
  const pole = new THREE.CylinderGeometry(0.08, 0.12, 6.5, 5); pole.translate(0, 3.25, 0);
  const head = new THREE.BoxGeometry(0.5, 0.18, 0.5); head.translate(0, 6.5, 0);
  const poleMesh = new THREE.InstancedMesh(mergeGeometries([pole, head]), new THREE.MeshStandardMaterial({ color: '#5d646b', roughness: 0.6, metalness: 0.4 }), pos.length);
  const m = new THREE.Matrix4();
  const glowPos = new Float32Array(pos.length * 3), poolPos = [];
  pos.forEach(([x, z, y], i) => { m.makeTranslation(x, y, z); poleMesh.setMatrixAt(i, m); glowPos.set([x, y + 6.3, z], i * 3); poolPos.push(x, z); });
  const glowGeo = new THREE.BufferGeometry(); glowGeo.setAttribute('position', new THREE.BufferAttribute(glowPos, 3));
  const tex = glowTexture();
  const glow = new THREE.Points(glowGeo, new THREE.PointsMaterial({ map: tex, size: 9, sizeAttenuation: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
  const pool = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0, color: '#ffb866' }), pos.length);
  pos.forEach(([x, z, y], i) => { m.makeScale(16, 1, 16).setPosition(x, y + 0.7, z); pool.setMatrixAt(i, m); });
  pool.renderOrder = 2; glow.renderOrder = 3;
  glow.visible = pool.visible = !lite;
  return { poleMesh, glow, pool, count: pos.length };
}

// ---------------------------------------------------------------- sky
function skyDome() {
  const geo = new THREE.SphereGeometry(16000, 32, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { uTop: { value: new THREE.Color() }, uHor: { value: new THREE.Color() }, uGround: { value: new THREE.Color() }, uSun: { value: new THREE.Vector3(0, 1, 0) }, uSunCol: { value: new THREE.Color() }, uSunVis: { value: 1 } },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * p; gl_Position.z = gl_Position.w; }',
    fragmentShader: `uniform vec3 uTop, uHor, uGround, uSun, uSunCol; uniform float uSunVis; varying vec3 vDir;
      void main(){ vec3 d = normalize(vDir); float h = d.y;
        vec3 c = h > 0.0 ? mix(uHor, uTop, pow(clamp(h, 0.0, 1.0), 0.55)) : mix(uHor, uGround, clamp(-h * 6.0, 0.0, 1.0));
        float s = max(dot(d, normalize(uSun)), 0.0);
        c += uSunCol * (pow(s, 900.0) * 6.0 + pow(s, 12.0) * 0.18) * uSunVis;
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat); mesh.renderOrder = -10; mesh.frustumCulled = false;
  return mesh;
}

function stars() {
  const n = 1400, p = new Float32Array(n * 3), r = rng(3);
  for (let i = 0; i < n; i++) {
    const u = r() * 2 - 1, th = r() * Math.PI * 2, y = Math.abs(u) * 0.95 + 0.05, rr = Math.sqrt(1 - y * y);
    p.set([Math.cos(th) * rr * 12000, y * 12000, Math.sin(th) * rr * 12000], i * 3);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  const pts = new THREE.Points(g, new THREE.PointsMaterial({ color: '#dfe8ff', size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false, fog: false }));
  pts.frustumCulled = false;
  return pts;
}

// ---------------------------------------------------------------- build all
export function buildWorld(model, opts = {}) {
  const lite = !!opts.lite;
  const root = new THREE.Group();
  const shared = { uState: { value: stateTexture(model.buildings.length) }, uNight: { value: 0 }, uAccent: { value: C('#ff6a3d') }, uWin: { value: 1 } };
  const noise = noiseTexture();

  // ground + campus fill
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(40000, 40000).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#b3b298', roughness: 1, map: noise }));
  ground.material.map = noise.clone(); ground.material.map.repeat.set(1200, 1200); ground.material.map.needsUpdate = true;
  ground.receiveShadow = true; ground.userData.pick = 'ground';
  root.add(ground);
  const A = new Buf();
  if (model.boundary) flatPoly(A, [model.boundary], 0.05, C('#a9ad73'));
  for (const a of model.areas.slice().reverse()) {
    if (a.kind === 'water') continue;
    const [col, y] = AREA[a.kind];
    const cc = C(a.kind === 'pitch' ? (PITCH[a.sport] || col) : col);
    if (!model.inCampus(a.cx, a.cz)) cc.lerp(C('#b3b298'), 0.35);
    flatPoly(A, a.rings, y + Math.min(0.05, 300 / (a.area + 3000)), cc);
  }
  const areas = new THREE.Mesh(A.geometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, map: noise }));
  areas.receiveShadow = true; areas.userData.pick = 'area';
  root.add(areas);
  const Wt = new Buf();
  for (const a of model.areas) if (a.kind === 'water') flatPoly(Wt, a.rings, AREA.water[1], C('#ffffff'));
  for (const bl of model.barriers) if (bl.kind === 'water') ribbon(Wt, bl.pts, bl.width, () => 0.31, C('#ffffff'), false);
  const water = new THREE.Mesh(Wt.geometry(), new THREE.MeshStandardMaterial({ color: '#3d7fb0', roughness: 0.12, metalness: 0.15, transparent: true, opacity: 0.92 }));
  water.receiveShadow = true;
  root.add(water);

  // roads
  const Rd = new Buf({ aU: 1 });
  const order = ['track', 'path', 'foot', 'steps', 'cycle', 'corridor', 'service', 'minor', 'major'];
  const roadsSorted = model.roads.slice().sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  for (const rd of roadsSorted) {
    const [col, y] = ROADS[rd.kind] || ROADS.service;
    const cc = C(col); if (!model.inCampus(rd.pts[0], rd.pts[1])) cc.lerp(C('#8d8a84'), 0.3);
    let yAt = () => y + rd.layer * 0.01;
    if (rd.bridge) {
      const cum = [0]; for (let i = 2; i < rd.pts.length; i += 2) cum.push(cum[cum.length - 1] + Math.hypot(rd.pts[i] - rd.pts[i - 2], rd.pts[i + 1] - rd.pts[i - 1]));
      const L = cum[cum.length - 1] || 1; yAt = (i) => y + 6.5 * Math.sin(Math.PI * cum[i] / L) ** 0.6;
    }
    ribbon(Rd, rd.pts, rd.width, yAt, cc, rd.kind !== 'path' && rd.kind !== 'track');
  }
  const roads = new THREE.Mesh(Rd.geometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, map: noise }));
  roads.receiveShadow = true;
  root.add(roads);

  // rails, walls, fences
  const Ln = new Buf();
  for (const rl of model.rails) {
    const y = rl.bridge ? 0.45 : 0.4;
    ribbon(Ln, rl.pts, 4, () => y - 0.05, C('#8a7f72'), false);
    for (const off of [-0.72, 0.72]) {
      const shifted = [];
      for (let i = 0; i < rl.pts.length; i += 2) {
        const j = Math.min(i + 2, rl.pts.length - 2), k = Math.max(i - 2, 0);
        const dx = rl.pts[j] - rl.pts[k], dz = rl.pts[j + 1] - rl.pts[k + 1], l = Math.hypot(dx, dz) || 1;
        shifted.push(rl.pts[i] + dz / l * off, rl.pts[i + 1] - dx / l * off);
      }
      ribbon(Ln, shifted, 0.14, () => y + 0.02, C('#4a4a4f'), false);
    }
  }
  for (const bl of model.barriers) {
    if (bl.kind === 'campus') fence(Ln, bl.pts, 2.2, C('#d6c6a8'));
    else if (bl.kind === 'wall' || bl.kind === 'retaining_wall' || bl.kind === 'city_wall') fence(Ln, bl.pts, 1.9, C('#cbbda4'));
    else if (bl.kind === 'fence') fence(Ln, bl.pts, 1.5, C('#7f8b7c'));
    else if (bl.kind === 'hedge') fence(Ln, bl.pts, 1.2, C('#4c7a3d'));
  }
  const lines = new THREE.Mesh(Ln.geometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide }));
  lines.receiveShadow = true; lines.castShadow = true;
  root.add(lines);

  // buildings
  const bgroup = new THREE.Group();
  const [walls, roofs] = buildingsMeshes(model, shared);
  bgroup.add(walls, roofs);
  root.add(bgroup);

  // trees, lamps
  const treeList = scatterTrees(model, lite ? 2500 : 11000, lite);
  const [canopy, trunks] = treesMesh(treeList);
  const tgroup = new THREE.Group(); tgroup.add(canopy, trunks);
  root.add(tgroup);
  const lp = lamps(model, lite);
  root.add(lp.poleMesh, lp.pool, lp.glow);

  const sky = skyDome(), starPts = stars();
  root.add(sky, starPts);

  return { root, shared, walls, roofs, bgroup, tgroup, areas, ground, water, roads, lines, lamps: lp, sky, stars: starPts, trees: treeList.length };
}

// ---------------------------------------------------------------- route ribbon
// width is set in the vertex shader so the line stays readable at any zoom
export function routeMesh(route, color = '#ff6a3d') {
  const p = route.pts, n = p.length / 2;
  const pos = [], side = [], us = [], idx = [];
  for (let i = 0; i < n; i++) {
    let dx = 0, dz = 0;
    if (i > 0) { const ax = p[2 * i] - p[2 * i - 2], az = p[2 * i + 1] - p[2 * i - 1], l = Math.hypot(ax, az) || 1; dx += ax / l; dz += az / l; }
    if (i < n - 1) { const bx = p[2 * i + 2] - p[2 * i], bz = p[2 * i + 3] - p[2 * i + 1], l = Math.hypot(bx, bz) || 1; dx += bx / l; dz += bz / l; }
    const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
    let m = 1;
    if (i > 0 && i < n - 1) { const ax = p[2 * i] - p[2 * i - 2], az = p[2 * i + 1] - p[2 * i - 1], la = Math.hypot(ax, az) || 1; m = 1 / Math.max(Math.abs((ax / la) * dx + (az / la) * dz), 0.5); }
    for (const sgn of [1, -1]) { pos.push(p[2 * i], 1.1, p[2 * i + 1]); side.push(-dz * m * sgn, dx * m * sgn); us.push(route.cum[i]); }
    if (i < n - 1) { const a = 2 * i; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aSide', new THREE.Float32BufferAttribute(side, 2));
  g.setAttribute('aU', new THREE.Float32BufferAttribute(us, 1));
  g.setIndex(idx);
  const half = { value: 3 };
  const vert = 'attribute vec2 aSide; attribute float aU; uniform float uHalf; uniform float uScale; varying float vU; void main(){ vU = aU; vec3 p = position + vec3(aSide.x, 0.0, aSide.y) * uHalf * uScale; gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0); }';
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: { uTime: { value: 0 }, uCol: { value: C(color) }, uHalf: half, uScale: { value: 1 } },
    vertexShader: vert,
    fragmentShader: `uniform float uTime; uniform vec3 uCol; uniform float uHalf; varying float vU;
      void main(){ float d = fract((vU - uTime * uHalf * 5.0) / (uHalf * 5.0)); float dash = smoothstep(0.0, 0.1, d) * (1.0 - smoothstep(0.5, 0.6, d));
        gl_FragColor = vec4(mix(uCol, vec3(1.0), dash * 0.5), 0.96);
        #include <colorspace_fragment>
      }`,
  });
  const haloMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: { uHalf: half, uScale: { value: 1.75 } },
    vertexShader: vert,
    fragmentShader: 'void main(){ gl_FragColor = vec4(0.08, 0.11, 0.16, 0.4); }',
  });
  const mesh = new THREE.Mesh(g, mat), halo = new THREE.Mesh(g, haloMat);
  mesh.renderOrder = 5; halo.renderOrder = 4; mesh.frustumCulled = halo.frustumCulled = false;
  const grp = new THREE.Group(); grp.add(halo, mesh); grp.userData.mat = mat; grp.userData.half = half;
  return grp;
}

export function markerMesh(color = '#2f7cf6') {
  const g = new THREE.Group();
  const disc = new THREE.Mesh(new THREE.CircleGeometry(3.2, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: '#ffffff', depthWrite: false }));
  const dot = new THREE.Mesh(new THREE.CircleGeometry(2.3, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color, depthWrite: false }));
  const cone = new THREE.Mesh(new THREE.CircleGeometry(14, 24, Math.PI / 2 - 0.45, 0.9).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.28, depthWrite: false }));
  const acc = new THREE.Mesh(new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.12, depthWrite: false }));
  disc.position.y = 1.3; dot.position.y = 1.35; cone.position.y = 1.25; acc.position.y = 1.2;
  g.add(acc, cone, disc, dot); g.userData = { cone, acc };
  for (const m of g.children) m.renderOrder = 6;
  return g;
}

export { CATS };

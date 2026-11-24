import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { buildCampus, CATS, SPOTS } from './osm.js';
import { buildWorld, routeMesh, markerMesh } from './world.js';
import { findRoute, along, progress, SPEED } from './route.js';
import { sunPosition, sunVector } from './sun.js';
import { Labels } from './labels.js';
import { Search } from './search.js';
import { ORIGIN, project, unproject, fmtDist, fmtMin, pointInRing } from './geo.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };
const touch = matchMedia('(pointer: coarse)').matches;
if (touch) document.body.classList.add('touch');

let toastT = 0;
function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), ms); }
const ld = (s) => { $('#ldText').textContent = s; };

// ------------------------------------------------------------------ data
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
async function getJSON(url) { const r = await fetch(url, { cache: 'no-cache' }); if (!r.ok) throw new Error(url + ' ' + r.status); return r.json(); }
const optional = (url, dflt) => getJSON(url).catch(() => dflt);

async function loadOSM() {
  try { return await getJSON('data/osm.json'); } catch { /* not built yet: ask Overpass directly */ }
  const KEY = 'https://cache.local/osm-v1';
  let cache = null;
  try { cache = await caches.open('iitbbs-3d'); const hit = await cache.match(KEY); if (hit && Date.now() - Number(hit.headers.get('x-at')) < 7 * 864e5) return await hit.json(); } catch { cache = null; }
  ld('Fetching the campus from OpenStreetMap…');
  const query = await (await fetch('scripts/campus.overpassql')).text();
  for (const url of OVERPASS) {
    try {
      const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(query), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      if (!r.ok) continue;
      const text = await r.text();
      const data = JSON.parse(text);
      if (!data.elements || data.elements.length < 200) continue;
      if (cache) cache.put(KEY, new Response(text, { headers: { 'x-at': String(Date.now()), 'content-type': 'application/json' } })).catch(() => {});
      return data;
    } catch { /* try the next mirror */ }
  }
  throw new Error('Could not reach OpenStreetMap');
}

// ------------------------------------------------------------------ globals
let model, world, search, labels, renderer, scene, camera, controls;
let sun, moon, hemi;
const S = {
  lite: store.get('lite') === '1' || (store.get('lite') === null && (navigator.hardwareConcurrency || 8) <= 4 && (navigator.deviceMemory || 8) <= 4),
  filter: 'all', selected: null, hover: -1, route: null, routeObj: null, mode: 'walk',
  dir: { from: null, to: null }, fly: null, preview: null, nav: null, walk: null, gps: null, gpsWatch: null,
  flat: false, lock: false, timeShift: 0, dirty: true, spotLabels: [], endLabels: [], spot: null, lastInteract: 0,
};
const sunDir = new THREE.Vector3(0, 1, 0);

// ------------------------------------------------------------------ boot
boot().catch((e) => {
  console.error(e);
  ld(e && /WebGL/i.test(e.message) ? 'This device or browser can’t show 3D (WebGL is off).' : 'Couldn’t load the campus map. Check your connection.');
  $('#ldRetry').hidden = false;
});
$('#ldRetry').onclick = () => location.reload();

async function boot() {
  const [osm, extra, places, people, overrides, meta] = await Promise.all([
    loadOSM(), optional('data/extra-buildings.json', []), optional('data/places.json', []),
    optional('data/people.json', null), optional('data/overrides.json', {}), optional('data/meta.json', null),
  ]);
  ld('Raising the buildings…');
  await new Promise((r) => setTimeout(r, 20));
  model = buildCampus({ osm, extra, places, people, overrides });
  initRenderer();
  world = buildWorld(model, { lite: S.lite });
  scene.add(world.root);
  initLights();
  search = new Search(model);
  initLabels();
  initUI(meta);
  updateSun();
  setInterval(() => { if (!S.timeShift) updateSun(); }, 30000);
  setView({ x: 40, z: 40, dist: 2300, polar: 0.92, az: 0.16 });
  window.__map = { model, world, S, findRoute, camera, controls }; // handy for debugging in the console
  applyHash();
  requestAnimationFrame(loop);
  setTimeout(() => $('#loader').classList.add('done'), 200);
  setTimeout(() => $('#loader').remove(), 900);
  watchFps();
}

// ------------------------------------------------------------------ renderer
function initRenderer() {
  const canvas = $('#c');
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: !S.lite, powerPreference: 'high-performance' });
  } catch { throw new Error('WebGL unavailable'); }
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, S.lite ? 1 : 2));
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = !S.lite;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xd6e6f2, 3000, 12000);
  camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 2, 40000);
  controls = new MapControls(camera, canvas);
  Object.assign(controls, { enableDamping: true, dampingFactor: 0.085, screenSpacePanning: false, maxPolarAngle: 1.32, minDistance: 28, maxDistance: 4600, zoomToCursor: true, zoomSpeed: 1.1 });
  controls.addEventListener('start', () => { S.fly = null; S.lastInteract = performance.now(); });
  controls.addEventListener('change', () => { S.dirty = true; });
  addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); S.dirty = true;
  });
}

function initLights() {
  hemi = new THREE.HemisphereLight(0xcfe4f5, 0x8f7a5e, 1.1);
  sun = new THREE.DirectionalLight(0xffffff, 2.8);
  sun.castShadow = !S.lite;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.6;
  moon = new THREE.DirectionalLight(0x9db4ff, 0);
  moon.position.set(-0.4, 1, 0.3).multiplyScalar(1000);
  scene.add(hemi, sun, sun.target, moon);
}

// ------------------------------------------------------------------ sun & time
const COL = {
  white: new THREE.Color('#fff4e3'), gold: new THREE.Color('#ffae66'),
  daySky: new THREE.Color('#cfe4f5'), nightSky: new THREE.Color('#22324f'), dayGround: new THREE.Color('#8f7a5e'), nightGround: new THREE.Color('#141821'),
  dayTop: new THREE.Color('#3f7fd0'), nightTop: new THREE.Color('#03060f'), dayHor: new THREE.Color('#d7e7f3'), nightHor: new THREE.Color('#0f1a30'), duskHor: new THREE.Color('#f2a66e'),
};
const darkPref = matchMedia('(prefers-color-scheme: dark)');
darkPref.addEventListener?.('change', () => updateSun());
const fmtTime = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });

function updateSun() {
  const t = new Date(Date.now() + S.timeShift * 60000);
  const { elevation: el, azimuth } = sunPosition(t, ORIGIN.lat, ORIGIN.lon);
  const v = sunVector(el, azimuth);
  sunDir.set(v[0], v[1], v[2]);
  const day = smooth(-7, 7, el), low = 1 - smooth(2, 26, el), night = 1 - smooth(-5, 3, el);
  sun.intensity = 2.9 * smooth(-1.5, 8, el);
  sun.color.copy(COL.white).lerp(COL.gold, low * 0.9);
  moon.intensity = 0.8 * night;
  hemi.intensity = 0.65 + 0.6 * day;
  hemi.color.copy(COL.nightSky).lerp(COL.daySky, day);
  hemi.groundColor.copy(COL.nightGround).lerp(COL.dayGround, day);
  const u = world.sky.material.uniforms;
  u.uTop.value.copy(COL.nightTop).lerp(COL.dayTop, day);
  u.uHor.value.copy(COL.nightHor).lerp(COL.dayHor, day).lerp(COL.duskHor, low * day * 0.75);
  u.uGround.value.copy(u.uHor.value).multiplyScalar(0.8);
  u.uSun.value.copy(sunDir); u.uSunCol.value.copy(sun.color).multiplyScalar(0.9); u.uSunVis.value = smooth(-3, 1, el);
  scene.fog.color.copy(u.uHor.value);
  world.shared.uNight.value = night;
  world.lamps.glow.material.opacity = night; world.lamps.pool.material.opacity = night * 0.5;
  world.stars.material.opacity = smooth(0.5, 1, night) * 0.9;
  renderer.toneMappingExposure = 0.9 + 0.12 * day;
  document.body.classList.toggle('dark', night > 0.55 || darkPref.matches);
  $('#timeText').textContent = fmtTime.format(t) + (S.timeShift ? '' : ' IST');
  $('#timeIcon').textContent = night > 0.55 ? '🌙' : low > 0.55 ? '🌅' : '☀️';
  $('#timePill').classList.toggle('shifted', !!S.timeShift);
  S.dirty = true;
}

function updateShadow() {
  const tgt = controls.target, d = camera.position.distanceTo(tgt);
  const half = Math.min(1700, Math.max(140, d * 0.85));
  sun.target.position.copy(tgt);
  sun.position.copy(tgt).addScaledVector(sunDir.y > 0.02 ? sunDir : new THREE.Vector3(0, 1, 0), 3200);
  const c = sun.shadow.camera;
  if (c.right !== half) { c.left = -half; c.right = half; c.top = half; c.bottom = -half; c.near = 100; c.far = 6500; c.updateProjectionMatrix(); }
  sun.target.updateMatrixWorld();
}

// ------------------------------------------------------------------ view helpers
const sph = new THREE.Spherical();
function getView() {
  sph.setFromVector3(camera.position.clone().sub(controls.target));
  return { x: controls.target.x, z: controls.target.z, dist: sph.radius, polar: sph.phi, az: sph.theta };
}
function setView(v) {
  controls.target.set(v.x, 0, v.z);
  camera.position.setFromSpherical(new THREE.Spherical(v.dist, Math.max(0.001, v.polar), v.az)).add(controls.target);
  camera.lookAt(controls.target);
  S.dirty = true;
}
function flyTo(to, dur = 1100) {
  const from = getView();
  const t = { x: to.x ?? from.x, z: to.z ?? from.z, dist: to.dist ?? from.dist, polar: to.polar ?? from.polar, az: to.az ?? from.az };
  if (S.flat) t.polar = 0.001;
  else if (S.lock) t.polar = from.polar;
  let da = t.az - from.az; da = Math.atan2(Math.sin(da), Math.cos(da)); t.az = from.az + da;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) dur = 1;
  S.fly = { from, to: t, t0: performance.now(), dur };
}
function stepFly(now) {
  const f = S.fly; if (!f) return;
  let k = Math.min(1, (now - f.t0) / f.dur); k = k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
  const L = (a, b) => a + (b - a) * k;
  // zoom out a little mid-flight when travelling far
  const span = Math.hypot(f.to.x - f.from.x, f.to.z - f.from.z), lift = Math.sin(k * Math.PI) * Math.min(span * 0.35, 900);
  setView({ x: L(f.from.x, f.to.x), z: L(f.from.z, f.to.z), dist: L(f.from.dist, f.to.dist) + lift, polar: L(f.from.polar, f.to.polar), az: L(f.from.az, f.to.az) });
  if (k >= 1) S.fly = null;
}
// keep the subject clear of the side panel (desktop) or bottom sheet (phones)
function framed(x, z, dist) {
  const az = S.fly ? S.fly.to.az : getView().az;
  if (innerWidth < 680) { const k = dist * 0.22; return { x: x + Math.sin(az) * k, z: z + Math.cos(az) * k }; }
  const k = dist * 0.17; return { x: x - Math.cos(az) * k, z: z + Math.sin(az) * k };
}
function fitBounds(pts, pad = 1.25) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < pts.length; i += 2) { x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i]); z0 = Math.min(z0, pts[i + 1]); z1 = Math.max(z1, pts[i + 1]); }
  const span = Math.max(x1 - x0, z1 - z0, 120) * (innerWidth < 680 ? 1.5 : 1.45);
  const dist = Math.min(4200, span * pad / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)))) + 60;
  flyTo({ ...framed((x0 + x1) / 2, (z0 + z1) / 2, dist), dist });
}

// ------------------------------------------------------------------ building state (highlight / dim / hover)
function setState(bid, ch, val) {
  if (bid == null || bid < 0) return;
  const tex = world.shared.uState.value;
  tex.image.data[bid * 4 + ch] = val; tex.needsUpdate = true; S.dirty = true;
}

// ------------------------------------------------------------------ labels & filters
const catColor = (c) => (CATS[c] || CATS.other).color;
function initLabels() {
  labels = new Labels($('#labels'), camera);
  const seen = [];
  const sorted = model.places.filter((p) => p.label && !p.unnamed && p.tier <= 4).sort((a, b) => a.tier - b.tier);
  for (const p of sorted) {
    if (seen.some((q) => q.label === p.label && Math.hypot(q.x - p.x, q.z - p.z) < 230)) continue;
    seen.push(p);
    const it = labels.add({ text: p.label, cat: catColor(p.cat), tier: p.tier, x: p.x, y: (p.y || 0) + 3, z: p.z, onClick: () => selectPlace(p) });
    it.data = p;
  }
  labels.filter = (it) => !it.data || S.filter === 'all' || matches(it.data, S.filter);
}
const FILTERS = [['all', 'All', '#1e2227'], ['academic', 'Academic'], ['hostel', 'Hostels'], ['food', 'Food'], ['shop', 'Shops'], ['sports', 'Sports'], ['health', 'Health'], ['worship', 'Worship'], ['admin', 'Admin & halls'], ['residential', 'Residential']];
function matches(p, f) { return f === 'admin' ? ['admin', 'civic', 'guest'].includes(p.cat) : p.cat === f; }
function initChips() {
  const box = $('#chips');
  for (const [id, label] of FILTERS) {
    if (id !== 'all' && !model.places.some((p) => !p.unnamed && matches(p, id))) continue;
    const b = document.createElement('button');
    b.className = 'chip' + (id === 'all' ? ' on' : ''); b.dataset.f = id;
    b.innerHTML = (id === 'all' ? '' : `<i style="background:${catColor(id === 'admin' ? 'admin' : id)}"></i>`) + esc(label);
    b.onclick = () => setFilter(S.filter === id ? 'all' : id);
    box.appendChild(b);
  }
}
function setFilter(f) {
  S.filter = f;
  for (const c of document.querySelectorAll('.chip')) c.classList.toggle('on', c.dataset.f === f);
  for (const b of model.buildings) setState(b.bid, 1, f === 'all' || (b.place && matches(b.place, f)) ? 0 : 255);
  if (f !== 'all') {
    const pts = []; for (const p of model.places) if (!p.unnamed && matches(p, f)) pts.push(p.x, p.z);
    if (pts.length) fitBounds(pts, 1.5);
  }
  S.dirty = true;
}

// ------------------------------------------------------------------ search
function resultRow(r, i, active) {
  let icon, title = r.name, sub = '';
  if (r.kind === 'person') { icon = `<span class="ri" style="background:#4b5563">${esc((r.name.replace(/^(Dr|Prof)\.?\s+/i, '')[0] || '?'))}</span>`; sub = [r.title, r.school, r.room].filter(Boolean).join(' · '); }
  else if (r.kind === 'spot') { icon = `<span class="ri" style="background:#f1e6d8">${r.icon}</span>`; sub = r.count ? `${r.count} on the map` : 'none mapped yet'; }
  else if (r.kind === 'me') { icon = '<span class="ri" style="background:#2f7cf6">◉</span>'; sub = 'Uses GPS'; }
  else { icon = `<span class="ri" style="background:${catColor(r.cat)}">${esc((r.short || r.name)[0])}</span>`; sub = [r.full || (CATS[r.cat] || CATS.other).label, r.short].filter(Boolean).join(' · '); }
  return `<button class="res${i === active ? ' on' : ''}" data-i="${i}" role="option">${icon}<span><b>${esc(title)}</b><small>${esc(sub)}</small></span>${r.kind === 'me' ? '' : '<span class="tab">Tab ↹ route</span>'}</button>`;
}
function bindList(input, box, getItems, choose, opts = {}) {
  let items = [], active = 0;
  const render = () => {
    items = getItems(input.value);
    box.hidden = !items.length && !input.value.trim();
    box.innerHTML = items.length ? items.map((r, i) => resultRow(r, i, active)).join('') : `<div class="empty">No match. Try a short form like SBS or MHR, or a professor's surname.</div>`;
    if (!input.value.trim() && !items.length) box.hidden = true;
  };
  input.addEventListener('input', () => { active = 0; render(); });
  input.addEventListener('focus', () => { if (input.value.trim() || opts.showEmpty) render(); });
  input.addEventListener('keydown', (e) => {
    if (box.hidden) return;
    if (e.key === 'ArrowDown') { active = Math.min(items.length - 1, active + 1); render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); render(); e.preventDefault(); }
    else if (e.key === 'Enter' && items[active]) { choose(items[active], false); box.hidden = true; e.preventDefault(); }
    else if (e.key === 'Tab' && items[active] && opts.tab) { opts.tab(items[active]); box.hidden = true; e.preventDefault(); }
  });
  box.addEventListener('pointerdown', (e) => e.preventDefault());
  box.addEventListener('click', (e) => { const b = e.target.closest('.res'); if (b) { choose(items[+b.dataset.i], true); box.hidden = true; } });
  input.addEventListener('blur', () => setTimeout(() => { box.hidden = true; }, 150));
}
function choose(r) {
  if (!r) return;
  $('#q').value = r.kind === 'spot' ? '' : r.name; $('#q').blur();
  if (r.kind === 'spot') openSpots(r.spot);
  else if (r.kind === 'person') selectPerson(r);
  else selectPlace(r);
}

// ------------------------------------------------------------------ place card
function closeSheets(except) {
  for (const id of ['card', 'dirPanel', 'spotsPanel', 'menuPanel']) if (id !== except) $('#' + id).hidden = true;
  if (except !== 'spotsPanel') clearSpots();
  document.body.classList.toggle('sheet-open', !!except);
}
function clearSelection() {
  if (S.selected && S.selected.bid !== undefined) setState(S.selected.bid, 0, 0);
  S.selected = null;
  for (const it of labels.items) it.el.classList.remove('sel');
}
function placeForBuilding(b) {
  return b.place || { id: b.id, kind: 'building', name: b.extra ? 'Building' : 'Unnamed building', label: '', cat: b.cat, x: b.cx, z: b.cz, y: b.h, bid: b.bid, tags: b.tags, aka: [], tier: 9, unnamed: true, extra: b.extra };
}
function selectPlace(p, { fly = true } = {}) {
  clearSelection();
  S.selected = p;
  if (p.bid !== undefined) setState(p.bid, 0, 255);
  for (const it of labels.items) if (it.data === p) it.el.classList.add('sel');
  const b = p.bid !== undefined ? model.buildings[p.bid] : null;
  if (fly) {
    const size = b ? Math.sqrt(b.area) : 30;
    const dist = Math.min(900, Math.max(170, size * 5));
    flyTo({ ...framed(p.x, p.z, dist), dist });
  }
  const t = p.tags || {}, c = CATS[p.cat] || CATS.other;
  const people = model.persons.filter((q) => q.bid !== undefined && q.bid === p.bid && p.bid !== undefined);
  const kv = [];
  if (b && b.levels) kv.push(['Floors', b.levels]);
  if (b && b.h && !b.extra) kv.push(['Height', `about ${Math.round(b.h)} m`]);
  if (t.opening_hours) kv.push(['Hours', esc(t.opening_hours)]);
  if (t.phone || t['contact:phone']) kv.push(['Phone', esc(t.phone || t['contact:phone'])]);
  if (t.website || t['contact:website']) { const w = t.website || t['contact:website']; kv.push(['Website', `<a href="${esc(w)}" target="_blank" rel="noopener">${esc(w.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''))}</a>`]); }
  if (t.email) kv.push(['Email', `<a href="mailto:${esc(t.email)}">${esc(t.email)}</a>`]);
  if (t.male === 'yes' || t.female === 'yes') kv.push(['For', t.female === 'yes' ? 'Women' : 'Men']);
  if (p.spot && SPOTS[p.spot] && p.unnamed) kv.push(['Type', SPOTS[p.spot][0]]);
  const osmLink = p.id && /^[wrn]\d/.test(p.id) ? `https://www.openstreetmap.org/${{ w: 'way', r: 'relation', n: 'node' }[p.id[0]]}/${p.id.slice(1)}` : null;
  const card = $('#card');
  card.innerHTML = `<button class="x" aria-label="Close">×</button>
    <h2>${esc(p.name)}</h2>
    <p class="sub">${esc(p.full || (p.short ? p.short + ' · ' : '') + c.label)}</p>
    <div class="tags"><span class="tag cat" style="background:${c.color}">${esc(c.label)}</span>${p.short ? `<span class="tag">${esc(p.short)}</span>` : ''}${p.src === 'overture' ? '<span class="tag">from Overture places</span>' : ''}${b && b.extra ? '<span class="tag">outline from satellite data</span>' : ''}</div>
    ${kv.length ? `<dl class="kv">${kv.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>` : ''}
    ${people.length ? `<details class="people"><summary>${people.length} professor${people.length > 1 ? 's' : ''} sit here</summary><ul>${people.map((q) => `<li data-id="${esc(q.id)}"><b>${esc(q.name)}</b><small>${esc([q.title, q.room].filter(Boolean).join(' · '))}</small></li>`).join('')}</ul></details>` : ''}
    <div class="acts"><button class="btn pri" data-a="dir">Directions</button><button class="btn" data-a="walk">Walk here</button><button class="btn" data-a="share">Share</button>${osmLink ? `<a class="btn" href="${osmLink}" target="_blank" rel="noopener">OSM</a>` : ''}</div>
    ${p.unnamed && b && !b.extra ? '<p class="note">This building has no name on OpenStreetMap yet. Know what it is? Add it there and it shows up here after the weekly refresh.</p>' : ''}`;
  card.querySelector('.x').onclick = () => { closeSheets(); clearSelection(); setHash(''); };
  card.querySelector('[data-a=dir]').onclick = () => openDirections(null, p);
  card.querySelector('[data-a=walk]').onclick = () => enterWalk(p);
  card.querySelector('[data-a=share]').onclick = () => share(p.name, '#p=' + encodeURIComponent(p.id));
  for (const li of card.querySelectorAll('.people li')) li.onclick = () => selectPerson(model.persons.find((q) => q.id === li.dataset.id));
  closeSheets('card'); card.hidden = false;
  setHash('#p=' + encodeURIComponent(p.id));
  S.dirty = true;
}
function selectPerson(q) {
  if (!q) return;
  if (q.bid !== undefined) {
    const b = model.buildings[q.bid];
    selectPlace(placeForBuilding(b));
  } else { clearSelection(); closeSheets('card'); }
  const card = $('#card');
  card.innerHTML = `<button class="x" aria-label="Close">×</button>
    <h2>${esc(q.name)}</h2><p class="sub">${esc([q.title, q.school && 'School of ' + q.school].filter(Boolean).join(', '))}</p>
    <dl class="kv">${q.room ? `<dt>Office</dt><dd>${esc(q.room)}</dd>` : ''}${q.building ? `<dt>Building</dt><dd>${esc(q.building)}</dd>` : ''}${q.email ? `<dt>Email</dt><dd>${q.email.split(/\s*\/\s*/).map((e) => `<a href="mailto:${esc(e)}">${esc(e)}</a>`).join('<br>')}</dd>` : ''}${q.phone ? `<dt>Phone</dt><dd>${esc(q.phone)}</dd>` : ''}${q.url ? `<dt>Profile</dt><dd><a href="${esc(q.url)}" target="_blank" rel="noopener">iitbbs.ac.in profile</a></dd>` : ''}</dl>
    ${q.bid === undefined ? '<p class="note">Their building isn’t on the map yet.</p>' : q.via === 'school' ? '<p class="note">Building inferred from their school; the room number comes from their profile.</p>' : ''}
    <div class="acts">${q.bid !== undefined ? '<button class="btn pri" data-a="dir">Directions</button>' : ''}<button class="btn" data-a="share">Share</button></div>`;
  card.querySelector('.x').onclick = () => { closeSheets(); clearSelection(); setHash(''); };
  const d = card.querySelector('[data-a=dir]'); if (d) d.onclick = () => openDirections(null, { ...q, name: q.name + "'s office" });
  card.querySelector('[data-a=share]').onclick = () => share(q.name, '#p=' + encodeURIComponent(q.id));
  card.hidden = false;
  setHash('#p=' + encodeURIComponent(q.id));
}

// ------------------------------------------------------------------ directions
const ME = { kind: 'me', id: 'me', name: 'Your location' };
function openDirections(from, to) {
  closeSheets('dirPanel'); $('#dirPanel').hidden = false;
  if (to) S.dir.to = to;
  if (from) S.dir.from = from;
  else if (!S.dir.from && S.gps && S.gps.inside) S.dir.from = ME;
  $('#fromIn').value = S.dir.from ? S.dir.from.name : '';
  $('#toIn').value = S.dir.to ? S.dir.to.name : '';
  if (S.dir.from && S.dir.to) { $('#endResults').hidden = true; document.activeElement?.blur?.(); computeRoute(); }
  else { $('#dirOut').innerHTML = '<p class="hint">Pick a start and an end. Start typing a building, hostel, short form (SBS, MHR) or professor.</p>'; (S.dir.from ? $('#toIn') : $('#fromIn')).focus(); }
}
function endItems(text, withMe) {
  const r = search.query(text, 8).filter((x) => x.kind !== 'spot');
  return withMe && !text.trim() ? [ME] : withMe && 'your location'.startsWith(text.trim().toLowerCase()) ? [ME, ...r] : r;
}
async function resolveEnd(e) {
  if (e.kind !== 'me') return e;
  const fix = await locate(true);
  if (!fix) return null;
  return { kind: 'me', name: 'Your location', x: fix.x, z: fix.z };
}
async function computeRoute() {
  const out = $('#dirOut');
  out.innerHTML = '<p class="hint">Finding the way…</p>';
  const from = await resolveEnd(S.dir.from), to = await resolveEnd(S.dir.to);
  if (!from || !to) { out.innerHTML = '<p class="warn">Couldn’t get your location. Pick a start point instead.</p>'; return; }
  let warn = '';
  if (from.kind === 'me' && S.gps && !S.gps.inside) warn = `<p class="warn">You seem to be ${fmtDist(S.gps.away)} from campus; the route starts at the nearest campus road.</p>`;
  const r = findRoute(model, from, to, S.mode);
  if (!r) { out.innerHTML = '<p class="warn">No walkable path found between these two on the mapped roads and paths.</p>'; clearRoute(); return; }
  showRoute(r);
  out.innerHTML = `${warn}<div class="sum"><b>${fmtMin(r.time)}</b><span>${fmtDist(r.dist)} · ${S.mode === 'walk' ? 'walking' : 'cycling'}</span></div>
    <div class="acts"><button class="btn pri" id="goStart">▶ Start</button><button class="btn" id="goPreview">Preview walk</button><button class="btn" id="goShare">Share</button></div>
    <ol class="steps">${r.steps.map((s, i) => `<li data-i="${i}"><span class="si">${ICON[s.icon] || '⬆'}</span><div>${esc(s.text)}${s.d ? `<small>${fmtDist(s.d)}</small>` : ''}</div></li>`).join('')}</ol>`;
  $('#goStart').onclick = () => startNav();
  $('#goPreview').onclick = () => startPreview();
  $('#goShare').onclick = () => share(`Route to ${r.toName}`, routeHash());
  for (const li of out.querySelectorAll('.steps li')) li.onclick = () => { const s = r.steps[+li.dataset.i], q = along(r, s.at); flyTo({ x: q.x, z: q.z, dist: 260 }); };
  setHash(routeHash());
  fitBounds(r.pts);
}
const ICON = { start: '⬆', arrive: '🏁', left: '⬅', right: '➡', 'left-slight': '↖', 'right-slight': '↗', 'left-sharp': '↙', 'right-sharp': '↘' };
const endKey = (e) => (!e ? '' : e.kind === 'me' ? 'me' : e.id && e.kind !== 'pin' ? encodeURIComponent(e.id) : `@${Math.round(e.x)},${Math.round(e.z)}`);
const routeHash = () => `#r=${endKey(S.dir.from)}~${endKey(S.dir.to)}${S.mode === 'cycle' ? '~cycle' : ''}`;
function showRoute(r) {
  clearRoute(false);
  S.route = r;
  S.routeObj = routeMesh(r, getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#c8553d');
  scene.add(S.routeObj);
  const a = r.pts, n = a.length;
  S.endLabels = [
    labels.add({ text: 'A', tier: 0, x: a[0], y: 2, z: a[1], cls: 'endpt', icon: '' }),
    labels.add({ text: (S.dir.to && (S.dir.to.label || S.dir.to.short)) || r.toName || 'B', tier: 0, x: a[n - 2], y: 2, z: a[n - 1], cls: 'endpt b', icon: '' }),
  ];
  for (const l of S.endLabels) l.el.querySelector('i').remove();
  S.dirty = true;
}
function clearRoute(all = true) {
  if (S.routeObj) { scene.remove(S.routeObj); S.routeObj.traverse((o) => o.geometry && o.geometry.dispose()); S.routeObj = null; }
  for (const l of S.endLabels) labels.remove(l);
  S.endLabels = [];
  if (all) { S.route = null; stopPreview(); stopNav(); }
  S.dirty = true;
}

// preview: play the walk
let walker = null;
function ensureWalker() { if (!walker) { walker = markerMesh('#2f7cf6'); scene.add(walker); } walker.visible = true; return walker; }
function startPreview() {
  if (!S.route) return;
  stopNav();
  const r = S.route, dur = Math.min(45, Math.max(12, r.dist / 16)) * 1000;
  S.preview = { t0: performance.now(), dur };
  ensureWalker();
  showHud();
  if (innerWidth < 680) $('#dirPanel').hidden = true;
}
function stopPreview() { if (S.preview) { S.preview = null; $('#navHud').hidden = true; if (walker && !S.gps) walker.visible = false; } }
function stepPreview(now) {
  const r = S.route, pv = S.preview;
  const k = Math.min(1, (now - pv.t0) / pv.dur), s = k * r.dist;
  const q = along(r, s);
  const b = Math.PI - q.heading;
  placeWalker(q.x, q.z, b, 0);
  const v = getView();
  let az = -b, da = Math.atan2(Math.sin(az - v.az), Math.cos(az - v.az));
  setView({ x: v.x + (q.x - v.x) * 0.12, z: v.z + (q.z - v.z) * 0.12, dist: v.dist + (230 - v.dist) * 0.05, polar: v.polar + (0.95 - v.polar) * 0.05, az: v.az + da * 0.04 });
  updateHud(s);
  if (k >= 1) { stopPreview(); toast('Arrived'); }
}
function placeWalker(x, z, bearing, acc) {
  const w = ensureWalker();
  w.position.set(x, 0, z);
  w.userData.cone.rotation.y = -bearing;
  w.userData.acc.scale.setScalar(Math.max(1, acc || 1));
  w.userData.acc.visible = !!acc;
  S.dirty = true;
}
function showHud() { $('#navHud').hidden = false; }
function updateHud(s) {
  const r = S.route;
  let next = r.steps.find((st) => st.at > s + 2) || r.steps[r.steps.length - 1];
  const left = Math.max(0, r.dist - s);
  $('#navIcon').textContent = ICON[next.icon] || '⬆';
  $('#navText').textContent = next.text;
  $('#navSub').textContent = next.icon === 'arrive' ? `in ${fmtDist(left)}` : `in ${fmtDist(Math.max(0, next.at - s))}`;
  $('#navLeft').textContent = `${fmtDist(left)} · ${fmtMin(left / SPEED[r.mode])} left`;
}

// live navigation with GPS
function startNav() {
  if (!S.route) return;
  stopPreview();
  if (!navigator.geolocation) { toast('Location isn’t available on this device'); return; }
  S.nav = { last: 0 };
  showHud(); updateHud(0);
  if (innerWidth < 680) $('#dirPanel').hidden = true;
  startWatch();
  toast('Following your location. Walk safely!');
}
function stopNav() { if (S.nav) { S.nav = null; $('#navHud').hidden = true; } }
$('#navStop').onclick = () => { stopNav(); stopPreview(); if (innerWidth < 680) $('#dirPanel').hidden = false; };
function onNavFix(fix) {
  if (!S.nav || !S.route) return;
  const r = S.route, pr = progress(r, fix.x, fix.z);
  updateHud(pr.s);
  if (r.dist - pr.s < 12) { toast('You have arrived'); stopNav(); return; }
  if (pr.off > 35 && performance.now() - S.nav.last > 8000) {
    S.nav.last = performance.now();
    const nr = findRoute(model, { kind: 'me', name: 'Your location', x: fix.x, z: fix.z }, S.dir.to, S.mode);
    if (nr) { showRoute(nr); toast('Re-routing'); }
  }
  if (performance.now() - S.lastInteract > 6000) flyTo({ x: fix.x, z: fix.z, dist: 260, polar: 0.9 }, 600);
}

// ------------------------------------------------------------------ location
function fixFrom(pos) {
  const [x, z] = project(pos.coords.latitude, pos.coords.longitude);
  const inside = model.boundary ? pointInRing(x, z, model.boundary) : true;
  const away = Math.hypot(x, z);
  return { x, z, acc: pos.coords.accuracy, heading: pos.coords.heading, inside: inside || away < 1800, away };
}
function locate(quiet) {
  return new Promise((res) => {
    if (S.gps && performance.now() - S.gps.t < 20000) return res(S.gps);
    if (!navigator.geolocation) { if (!quiet) toast('Location isn’t available here'); return res(null); }
    navigator.geolocation.getCurrentPosition((pos) => { S.gps = { ...fixFrom(pos), t: performance.now() }; showMe(); res(S.gps); },
      (err) => { if (!quiet) toast(err.code === 1 ? 'Location permission was denied' : 'Couldn’t get your location'); res(null); },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 10000 });
  });
}
function startWatch() {
  if (S.gpsWatch !== null || !navigator.geolocation) return;
  S.gpsWatch = navigator.geolocation.watchPosition((pos) => { S.gps = { ...fixFrom(pos), t: performance.now() }; showMe(); onNavFix(S.gps); }, () => {}, { enableHighAccuracy: true, maximumAge: 3000 });
}
function showMe() {
  const g = S.gps; if (!g) return;
  placeWalker(g.x, g.z, g.heading ? g.heading * Math.PI / 180 : 0, g.acc);
  walker.userData.cone.visible = g.heading != null && !isNaN(g.heading);
}
$('#btnLocate').onclick = async () => {
  const g = await locate(false);
  if (!g) return;
  startWatch();
  if (!g.inside) toast(`You're about ${fmtDist(g.away)} from campus`);
  flyTo({ x: g.x, z: g.z, dist: g.inside ? 320 : 2600 });
};

// ------------------------------------------------------------------ useful spots
function spotPlaces(id) { return model.places.filter((p) => p.spot === id); }
function initSpots() {
  $('#spotGrid').innerHTML = Object.entries(SPOTS).map(([id, [label, icon]]) => {
    const n = spotPlaces(id).length;
    return `<button class="spot${n ? '' : ' none'}" data-s="${id}"><span>${icon}</span>${esc(label)}<small>${n || 'none yet'}</small></button>`;
  }).join('');
  for (const b of document.querySelectorAll('.spot')) b.onclick = () => openSpots(b.dataset.s);
}
function clearSpots() { for (const l of S.spotLabels) labels.remove(l); S.spotLabels = []; S.spot = null; for (const b of document.querySelectorAll('.spot')) b.classList.remove('on'); S.dirty = true; }
function openSpots(id) {
  closeSheets('spotsPanel'); $('#spotsPanel').hidden = false;
  clearSpots();
  if (!id) { $('#spotList').innerHTML = '<p class="hint">Pick what you need; the nearest ones are listed first.</p>'; return; }
  S.spot = id;
  for (const b of document.querySelectorAll('.spot')) b.classList.toggle('on', b.dataset.s === id);
  const list = spotPlaces(id);
  const ref = S.gps && S.gps.inside ? S.gps : { x: controls.target.x, z: controls.target.z };
  list.sort((a, b) => Math.hypot(a.x - ref.x, a.z - ref.z) - Math.hypot(b.x - ref.x, b.z - ref.z));
  if (!list.length) {
    const ll = unproject(controls.target.x, controls.target.z);
    $('#spotList').innerHTML = `<p class="hint">No ${esc(SPOTS[id][0].toLowerCase())} is mapped on campus yet. Know one? <a href="https://www.openstreetmap.org/edit#map=19/${ll.lat.toFixed(5)}/${ll.lon.toFixed(5)}" target="_blank" rel="noopener">Add it on OpenStreetMap</a> and it appears here after the weekly refresh.</p>`;
    return;
  }
  for (const p of list) {
    const l = labels.add({ text: p.unnamed ? SPOTS[id][0].replace(/ &.*/, '') : p.label || p.name, tier: 0, x: p.x, y: (p.y || 2) + 2, z: p.z, cls: 'spot', icon: SPOTS[id][1], onClick: () => selectPlace(p) });
    S.spotLabels.push(l);
  }
  $('#spotList').innerHTML = list.map((p, i) => `<button class="res" data-i="${i}"><span class="ri" style="background:#f1e6d8">${SPOTS[id][1]}</span><span><b>${esc(p.unnamed ? SPOTS[id][0] : p.name)}</b><small>${fmtDist(Math.hypot(p.x - ref.x, p.z - ref.z))} away${p.src === 'overture' ? ' · Overture' : ''}</small></span></button>`).join('');
  for (const b of $('#spotList').querySelectorAll('.res')) b.onclick = () => { const p = list[+b.dataset.i]; selectPlace(p); };
  const pts = []; for (const p of list) pts.push(p.x, p.z);
  if (list.length > 1) fitBounds(pts, 1.6); else flyTo({ x: list[0].x, z: list[0].z, dist: 400 });
}

// ------------------------------------------------------------------ walk mode
const keys = new Set();
function enterWalk(p) {
  closeSheets(); stopPreview();
  const v = getView();
  let x = v.x, z = v.z, yaw = v.az;
  if (p) {
    const b = p.bid !== undefined ? model.buildings[p.bid] : null;
    const [dx, dz] = b ? [b.cx, b.cz] : [p.x, p.z];
    const s = findRoute(model, p, p, 'walk');
    const sx = s ? s.from.x : p.x + 30, sz = s ? s.from.z : p.z + 30;
    x = sx; z = sz; yaw = Math.atan2(-(dx - sx), -(dz - sz));
  } else {
    const hit = model.nav && findRoute(model, { x, z }, { x, z }, 'walk');
    if (hit) { x = hit.from.x; z = hit.from.z; }
  }
  S.walk = { x, z, yaw, pitch: 0.02, saved: v, fog: [scene.fog.near, scene.fog.far] };
  controls.enabled = false;
  scene.fog.near = 120; scene.fog.far = 1600;
  camera.near = 0.2; camera.updateProjectionMatrix();
  document.body.classList.add('walking');
  $('#walkHud').hidden = false;
  S.dirty = true;
}
function exitWalk() {
  if (!S.walk) return;
  const w = S.walk; S.walk = null;
  [scene.fog.near, scene.fog.far] = w.fog;
  controls.enabled = true;
  document.body.classList.remove('walking');
  $('#walkHud').hidden = true;
  camera.up.set(0, 1, 0);
  setView(w.saved);
}
function stepWalk(dt) {
  const w = S.walk;
  let fwd = 0, side = 0;
  if (keys.has('w') || keys.has('arrowup')) fwd += 1;
  if (keys.has('s') || keys.has('arrowdown')) fwd -= 1;
  if (keys.has('a') || keys.has('arrowleft')) side -= 1;
  if (keys.has('d') || keys.has('arrowright')) side += 1;
  if (joy.active) { fwd += -joy.y; side += joy.x; }
  const speed = (keys.has('shift') ? 9 : 3.2) * dt;
  if (fwd || side) {
    const sx = Math.sin(w.yaw), cz = Math.cos(w.yaw);
    const nx = w.x + (-sx * fwd + cz * side) * speed, nz = w.z + (-cz * fwd - sx * side) * speed;
    if (!model.buildingAt(nx, nz)) { w.x = nx; w.z = nz; }
    else if (!model.buildingAt(nx, w.z)) w.x = nx;
    else if (!model.buildingAt(w.x, nz)) w.z = nz;
  }
  camera.position.set(w.x, 1.7, w.z);
  camera.rotation.set(w.pitch, w.yaw, 0, 'YXZ');
  S.dirty = true;
}
const joy = { active: false, x: 0, y: 0, id: null };
(() => {
  const pad = $('#joy'), knob = $('#joyKnob');
  pad.addEventListener('pointerdown', (e) => { joy.active = true; joy.id = e.pointerId; pad.setPointerCapture(e.pointerId); move(e); });
  pad.addEventListener('pointermove', (e) => { if (joy.active && e.pointerId === joy.id) move(e); });
  const end = () => { joy.active = false; joy.x = joy.y = 0; knob.style.transform = ''; };
  pad.addEventListener('pointerup', end); pad.addEventListener('pointercancel', end);
  function move(e) {
    const r = pad.getBoundingClientRect(), dx = e.clientX - r.left - r.width / 2, dy = e.clientY - r.top - r.height / 2, m = Math.hypot(dx, dy), lim = 40;
    const k = m > lim ? lim / m : 1;
    joy.x = dx * k / lim; joy.y = dy * k / lim;
    knob.style.transform = `translate(${dx * k}px,${dy * k}px)`;
  }
})();
$('#walkExit').onclick = exitWalk;

// ------------------------------------------------------------------ picking & gestures
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
function pick(cx, cy) {
  ndc.set(cx / innerWidth * 2 - 1, -(cy / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hits = ray.intersectObjects([world.walls, world.roofs, world.areas, world.ground], false);
  return hits[0] || null;
}
function hitBuilding(h) {
  if (!h || (h.object !== world.walls && h.object !== world.roofs)) return -1;
  return h.object.geometry.attributes.aBid.getX(h.face.a);
}
let down = null, lastTap = { t: 0, x: 0, y: 0 }, look = null;
const canvas = () => renderer.domElement;
function initPointer() {
  const c = canvas();
  c.addEventListener('pointerdown', (e) => {
    down = { x: e.clientX, y: e.clientY, t: performance.now() };
    if (S.walk) { look = { x: e.clientX, y: e.clientY, id: e.pointerId }; c.setPointerCapture(e.pointerId); }
  });
  c.addEventListener('pointermove', (e) => {
    if (S.walk && look && e.pointerId === look.id) {
      S.walk.yaw -= (e.clientX - look.x) * 0.0042; S.walk.pitch = Math.max(-1.2, Math.min(1.2, S.walk.pitch - (e.clientY - look.y) * 0.0042));
      look.x = e.clientX; look.y = e.clientY; return;
    }
    if (touch || S.walk || down) return;
    hoverAt(e.clientX, e.clientY);
  });
  c.addEventListener('pointerup', (e) => {
    look = null;
    if (!down || S.walk) { down = null; return; }
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y), dt = performance.now() - down.t;
    down = null;
    if (moved > 7 || dt > 600) return;
    const now = performance.now();
    if (now - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
      const h = pick(e.clientX, e.clientY), v = getView();
      if (h) flyTo({ x: h.point.x, z: h.point.z, dist: Math.max(controls.minDistance, v.dist * 0.45) }, 500);
      lastTap.t = 0; return;
    }
    lastTap = { t: now, x: e.clientX, y: e.clientY };
    const h = pick(e.clientX, e.clientY), bid = hitBuilding(h);
    if (bid >= 0) { selectPlace(placeForBuilding(model.buildings[bid]), { fly: false }); return; }
    if (h && h.object === world.areas) {
      const a = model.places.find((p) => p.kind === 'area' && !p.unnamed && model.areas.find((q) => q.id === p.id && pointInRing(h.point.x, h.point.z, q.rings[0])));
      if (a) { selectPlace(a, { fly: false }); return; }
    }
    if (!$('#card').hidden) { $('#card').hidden = true; clearSelection(); setHash(S.route ? routeHash() : ''); }
  });
  c.addEventListener('dblclick', (e) => e.preventDefault());
}
let hoverT = 0;
function hoverAt(x, y) {
  const now = performance.now(); if (now - hoverT < 70) return; hoverT = now;
  const bid = hitBuilding(pick(x, y));
  if (bid !== S.hover) { setState(S.hover, 2, 0); S.hover = bid; setState(bid, 2, 255); canvas().style.cursor = bid >= 0 ? 'pointer' : ''; }
}

// ------------------------------------------------------------------ share & hash
async function share(title, hash) {
  const url = location.origin + location.pathname + hash;
  if (navigator.share && touch) { try { await navigator.share({ title: title + ' · IIT Bhubaneswar in 3D', url }); return; } catch { /* cancelled */ } }
  try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch { prompt('Copy this link', url); }
}
function setHash(h) { history.replaceState(null, '', h || location.pathname + location.search); }
function findById(id) {
  if (!id) return null;
  if (id === 'me') return ME;
  if (id[0] === '@') { const [x, z] = id.slice(1).split(',').map(Number); return { kind: 'pin', name: 'Dropped pin', x, z }; }
  if (id.startsWith('p:')) return model.persons.find((q) => q.id === id) || null;
  const p = model.places.find((q) => q.id === id);
  if (p) return p;
  const b = model.buildings.find((q) => q.id === id);
  return b ? placeForBuilding(b) : null;
}
function applyHash() {
  const h = decodeURIComponent(location.hash.slice(1));
  if (h.startsWith('p=')) {
    const x = findById(h.slice(2));
    if (x) (x.kind === 'person' ? selectPerson : selectPlace)(x);
  } else if (h.startsWith('r=')) {
    const [a, b, m] = h.slice(2).split('~');
    if (m === 'cycle') setMode('cycle');
    const f = findById(a), t = findById(b);
    if (f || t) openDirections(f, t);
  }
}
addEventListener('hashchange', applyHash);

// ------------------------------------------------------------------ UI wiring
function setMode(m) {
  S.mode = m;
  for (const b of document.querySelectorAll('.modes button')) { b.classList.toggle('on', b.dataset.mode === m); b.setAttribute('aria-checked', b.dataset.mode === m); }
}
function initUI(meta) {
  initChips(); initSpots(); initPointer();
  bindList($('#q'), $('#results'), (t) => search.query(t), choose, { tab: (r) => { $('#q').value = ''; $('#q').blur(); if (r.kind === 'spot') openSpots(r.spot); else openDirections(null, r); } });
  bindList($('#fromIn'), $('#endResults'), (t) => endItems(t, true), (r) => { S.dir.from = r; $('#fromIn').value = r.name; if (S.dir.to) computeRoute(); else $('#toIn').focus(); }, { showEmpty: true });
  bindList($('#toIn'), $('#endResults'), (t) => endItems(t, true), (r) => { S.dir.to = r; $('#toIn').value = r.name; if (S.dir.from) computeRoute(); else $('#fromIn').focus(); }, { showEmpty: true });
  $('#swap').onclick = () => { [S.dir.from, S.dir.to] = [S.dir.to, S.dir.from]; $('#fromIn').value = S.dir.from ? S.dir.from.name : ''; $('#toIn').value = S.dir.to ? S.dir.to.name : ''; if (S.dir.from && S.dir.to) computeRoute(); };
  for (const b of document.querySelectorAll('.modes button')) b.onclick = () => { setMode(b.dataset.mode); if (S.dir.from && S.dir.to) computeRoute(); };
  $('#btnDir').onclick = () => openDirections(null, S.selected && S.selected.kind !== 'spot' ? S.selected : null);
  $('#btnSpots').onclick = () => ($('#spotsPanel').hidden ? openSpots(null) : closeSheets());
  $('#btnMenu').onclick = () => { const open = $('#menuPanel').hidden; closeSheets(open ? 'menuPanel' : undefined); $('#menuPanel').hidden = !open; };
  for (const x of document.querySelectorAll('[data-close]')) x.onclick = () => {
    const id = x.dataset.close; $('#' + id).hidden = true; document.body.classList.remove('sheet-open');
    if (id === 'dirPanel') { clearRoute(); setHash(''); }
    if (id === 'spotsPanel') clearSpots();
  };
  $('#compass').onclick = () => flyTo({ az: 0 }, 600);
  $('#btn2d').onclick = () => toggleFlat();
  $('#btnLock').onclick = () => {
    S.lock = !S.lock; $('#btnLock').setAttribute('aria-pressed', S.lock);
    const p = getView().polar;
    controls.minPolarAngle = S.lock ? p : 0; controls.maxPolarAngle = S.lock ? p : 1.32;
    if (S.flat) { controls.minPolarAngle = 0; controls.maxPolarAngle = 0.001; }
    toast(S.lock ? 'Tilt locked: pinch and scroll only zoom' : 'Tilt unlocked');
  };
  $('#btnWalk').onclick = () => enterWalk(S.selected);
  $('#timePill').onclick = () => { $('#timePanel').hidden = !$('#timePanel').hidden; };
  $('#timeRange').oninput = (e) => { S.timeShift = +e.target.value; updateSun(); };
  $('#timeLive').onclick = () => { S.timeShift = 0; $('#timeRange').value = 0; updateSun(); $('#timePanel').hidden = true; };
  $('#optLite').checked = S.lite;
  $('#optLite').onchange = (e) => setLite(e.target.checked, true);
  $('#optTrees').onchange = (e) => { world.tgroup.visible = e.target.checked; S.dirty = true; };
  $('#optLabels').onchange = (e) => { $('#labels').style.display = e.target.checked ? '' : 'none'; };
  const nB = model.buildings.filter((b) => !b.extra).length, nX = model.buildings.length - nB;
  $('#dataInfo').textContent = `${nB} buildings from OpenStreetMap${nX ? ` and ${nX} outlines from Overture Maps` : ''}, ${model.roads.length} roads and paths, ${model.persons.length} professors.` + (meta && meta.built ? ` Data refreshed ${new Date(meta.built).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}.` : '');
  addEventListener('keydown', (e) => {
    const typing = /INPUT|TEXTAREA/.test(document.activeElement.tagName);
    if (S.walk) { keys.add(e.key.toLowerCase()); if (e.key === 'Escape') exitWalk(); return; }
    if ((e.key === '/' && !typing) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) { e.preventDefault(); $('#q').focus(); $('#q').select(); return; }
    if (e.key === 'Escape') {
      if (typing) { document.activeElement.blur(); return; }
      if (S.preview || S.nav) { stopPreview(); stopNav(); return; }
      closeSheets(); clearSelection(); $('#timePanel').hidden = true; setHash(S.route ? routeHash() : '');
    }
  });
  addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
  addEventListener('blur', () => keys.clear());
}

function toggleFlat() {
  S.flat = !S.flat;
  $('#btn2d').setAttribute('aria-pressed', S.flat); $('#btn2d').textContent = S.flat ? '3D' : '2D';
  labels.flat = S.flat;
  if (S.flat) { S.savedPolar = getView().polar; controls.minPolarAngle = 0; controls.maxPolarAngle = 0.001; flyTo({ polar: 0.001 }, 700); }
  else { controls.minPolarAngle = S.lock ? S.savedPolar : 0; controls.maxPolarAngle = S.lock ? S.savedPolar : 1.32; flyTo({ polar: S.savedPolar || 0.9 }, 700); }
  S.flatAnim = { t0: performance.now(), from: world.bgroup.scale.y, to: S.flat ? 0.04 : 1 };
}

function setLite(on, user) {
  S.lite = on; if (user) store.set('lite', on ? '1' : '0');
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, on ? 1 : 2));
  renderer.shadowMap.enabled = !on; sun.castShadow = !on;
  scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
  const [canopy, trunks] = world.tgroup.children;
  canopy.count = trunks.count = on ? Math.floor(world.trees * 0.35) : world.trees;
  world.lamps.glow.visible = world.lamps.pool.visible = !on;
  $('#optLite').checked = on;
  S.dirty = true;
}
function watchFps() {
  if (S.lite) return;
  let frames = 0, t0 = 0;
  const tick = (t) => {
    if (!t0) t0 = t;
    frames++;
    if (t - t0 > 4000) {
      const fps = frames * 1000 / (t - t0);
      if (fps < 24 && store.get('lite') === null) { setLite(true, false); toast('Switched to lighter mode for smoother movement'); }
      return;
    }
    S.dirty = true;
    requestAnimationFrame(tick);
  };
  setTimeout(() => requestAnimationFrame(tick), 2500);
}

// ------------------------------------------------------------------ loop
let lastT = performance.now(), lastLabelView = '';
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.1, (now - lastT) / 1000); lastT = now;
  let changed = false;
  if (S.walk) { stepWalk(dt); changed = true; }
  else {
    if (S.fly) { stepFly(now); changed = true; }
    if (S.preview) { stepPreview(now); changed = true; }
    if (controls.update()) changed = true;
    // keep the view near campus
    const t = controls.target, e = model.ext, m = 700;
    const cx = Math.min(e[2] + m, Math.max(e[0] - m, t.x)), cz = Math.min(e[3] + m, Math.max(e[1] - m, t.z));
    if (cx !== t.x || cz !== t.z) { camera.position.x += cx - t.x; camera.position.z += cz - t.z; t.x = cx; t.z = cz; }
    const d = camera.position.distanceTo(t), near = Math.min(12, Math.max(0.5, d * 0.006));
    if (Math.abs(camera.near - near) / near > 0.2) { camera.near = near; camera.updateProjectionMatrix(); }
  }
  if (S.flatAnim) {
    const k = Math.min(1, (now - S.flatAnim.t0) / 700);
    world.bgroup.scale.y = S.flatAnim.from + (S.flatAnim.to - S.flatAnim.from) * (1 - (1 - k) ** 3);
    world.tgroup.scale.y = world.bgroup.scale.y;
    if (k >= 1) S.flatAnim = null;
    changed = true;
  }
  if (S.routeObj) { S.routeObj.userData.mat.uniforms.uTime.value = now / 1000; S.routeObj.userData.half.value = Math.min(14, Math.max(1.6, camera.position.distanceTo(S.walk ? camera.position : controls.target) * 0.0042)); changed = true; }
  if (!changed && !S.dirty) return;
  S.dirty = false;
  if (!S.walk) updateShadow();
  camera.updateMatrixWorld(); // labels must use this frame's camera, not the last one
  world.sky.position.copy(camera.position);
  world.stars.position.copy(camera.position);
  const az = S.walk ? S.walk.yaw : getView().az;
  $('#compass svg').style.transform = `rotate(${(az * 180 / Math.PI).toFixed(1)}deg)`;
  const key = camera.position.toArray().map((v) => v.toFixed(1)).join() + labels.items.length + S.filter;
  if (key !== lastLabelView || labels.items.some((i) => !i.w)) { labels.update(innerWidth, innerHeight, S.walk ? 260 : Infinity); lastLabelView = key; }
  renderer.render(scene, camera);
}

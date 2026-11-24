// Turns a raw Overpass answer (+ optional Overture fill-ins, faculty list and
// hand-kept overrides) into the campus model the scene, search and router use.
import { project, signedArea, centroid, bbox, pointInRing, pointInPoly, simplify, Grid, closestOnSeg, distToRing } from './geo.js';

export const CATS = {
  academic: { label: 'Academic', color: '#c8553d' },
  hostel: { label: 'Hostels', color: '#2f6fb5' },
  food: { label: 'Food', color: '#e09a1f' },
  shop: { label: 'Shops', color: '#8e5bb5' },
  sports: { label: 'Sports', color: '#2f9a5b' },
  health: { label: 'Health', color: '#d64545' },
  worship: { label: 'Worship', color: '#b8892b' },
  admin: { label: 'Admin', color: '#0f766e' },
  civic: { label: 'Civic', color: '#0f766e' },
  guest: { label: 'Guest house', color: '#b0587a' },
  residential: { label: 'Residential', color: '#6f7f8f' },
  other: { label: 'Other', color: '#8a8f98' },
};

// useful-spot groups: id -> [label, icon]
export const SPOTS = {
  water: ['Drinking water', '💧'], toilets: ['Toilets', '🚻'], atm: ['ATM & bank', '🏧'],
  food: ['Food & café', '🍽️'], shop: ['Shops', '🛍️'], medical: ['Pharmacy & medical', '💊'],
  print: ['Print & photocopy', '🖨️'], laundry: ['Laundry', '🧺'], salon: ['Salon', '💈'],
  post: ['Post office', '📮'], bike: ['Cycle parking & repair', '🚲'], ev: ['EV charging', '🔌'],
  lecture: ['Lecture halls', '🎓'], sports: ['Sports', '🏏'], parking: ['Parking', '🅿️'],
  worship: ['Temple & worship', '🛕'], gate: ['Gates', '🚪'], bus: ['Bus stop', '🚌'],
};

const ROAD = {
  motorway: ['major', 12], trunk: ['major', 11], primary: ['major', 10], secondary: ['major', 9], tertiary: ['major', 8],
  motorway_link: ['major', 6], trunk_link: ['major', 6], primary_link: ['major', 6], secondary_link: ['major', 6], tertiary_link: ['major', 6],
  unclassified: ['minor', 7], residential: ['minor', 6.5], living_street: ['minor', 5], service: ['service', 5],
  pedestrian: ['foot', 4], footway: ['foot', 2.2], path: ['path', 1.8], cycleway: ['cycle', 2.5], bridleway: ['path', 2],
  steps: ['steps', 2.4], track: ['track', 3.5], corridor: ['corridor', 2], road: ['minor', 5],
};
const NO_ROUTE = new Set(['construction', 'proposed', 'platform', 'bus_stop', 'elevator', 'raceway', 'abandoned', 'razed']);

const num = (v) => { const n = parseFloat(String(v || '').replace(',', '.')); return isFinite(n) ? n : null; };
const clean = (s) => (s || '').replace(/^IIT (Bhubaneswar |BBS )?/i, '').trim();

function areaKind(t) {
  if (t.building) return null;
  const l = t.landuse, n = t.natural, le = t.leisure;
  if (n === 'water' || t.water || l === 'reservoir' || l === 'basin' || le === 'swimming_pool' || t.amenity === 'fountain') return 'water';
  if (le === 'pitch') return 'pitch';
  if (le === 'track') return 'track';
  if (le === 'stadium' || le === 'sports_centre') return 'sports';
  if (t.amenity === 'parking') return 'parking';
  if (l === 'forest' || n === 'wood') return 'forest';
  if (n === 'scrub' || n === 'heath') return 'scrub';
  if (n === 'wetland') return 'wetland';
  if (le === 'park' || le === 'garden' || l === 'grass' || n === 'grassland' || l === 'meadow' || l === 'recreation_ground' || l === 'village_green' || le === 'playground') return 'grass';
  if (l === 'farmland' || l === 'orchard' || l === 'plant_nursery' || l === 'farmyard') return 'farm';
  if (l === 'construction' || l === 'brownfield' || l === 'greenfield') return 'construction';
  if (n === 'sand' || n === 'bare_rock' || n === 'beach') return 'sand';
  return null;
}

function classify(t, name) {
  const n = (name || '').toLowerCase();
  const a = t.amenity || '', b = t.building || '';
  if (a === 'dormitory' || b === 'dormitory' || t.tourism === 'hostel' || /hall of residence|hostel/.test(n)) return 'hostel';
  if (/lecture|classroom/.test(n)) return 'academic';
  if (['restaurant', 'cafe', 'fast_food', 'food_court', 'canteen', 'ice_cream', 'bar', 'pub'].includes(a) || /canteen|mess\b|caf[eé]|food|dhaba|juice/.test(n)) return 'food';
  if (['hospital', 'clinic', 'doctors', 'pharmacy', 'dentist'].includes(a) || t.healthcare || b === 'hospital' || /hospital|health|medical|dispensary/.test(n)) return 'health';
  if (a === 'place_of_worship' || b === 'temple' || /temple|mandir|mosque|church|gurudwara/.test(n)) return 'worship';
  if (t.shop || b === 'retail' || b === 'commercial' || /shop|market|store|stationery/.test(n)) return 'shop';
  if (t.leisure || t.sport || /ground|court|field|gym|sports|stadium|pool/.test(n)) return 'sports';
  if (t.tourism === 'guest_house' || /guest ?house/.test(n)) return 'guest';
  if (/admin|registrar|director'?s office/.test(n) || t.office) return 'admin';
  if (b === 'university' || b === 'college' || a === 'university' || a === 'library' || /school of|department|lab|workshop|library|academic/.test(n)) return 'academic';
  if (['apartments', 'residential', 'house', 'detached', 'terrace', 'semidetached_house', 'bungalow'].includes(b) || /quarter|residence|apartment|bungalow/.test(n)) return 'residential';
  if (['community_centre', 'conference_centre', 'arts_centre', 'theatre', 'townhall', 'post_office', 'bank', 'police'].includes(a) || /auditorium|activity|community|centre|center/.test(n)) return 'civic';
  return 'other';
}

function spotOf(t, sub) {
  const a = t.amenity, s = t.shop;
  if (sub === 'lecture') return 'lecture';
  if (a === 'drinking_water' || a === 'water_point' || t.drinking_water === 'yes' && !t.building) return 'water';
  if (a === 'toilets') return 'toilets';
  if (a === 'atm' || a === 'bank' || a === 'bureau_de_change') return 'atm';
  if (['restaurant', 'cafe', 'fast_food', 'food_court', 'canteen', 'ice_cream'].includes(a) || ['bakery', 'confectionery', 'beverages'].includes(s)) return 'food';
  if (['pharmacy', 'hospital', 'clinic', 'doctors', 'dentist'].includes(a) || t.healthcare || s === 'chemist') return 'medical';
  if (s === 'copyshop' || a === 'printer' || t.craft === 'photocopy') return 'print';
  if (s === 'laundry' || s === 'dry_cleaning') return 'laundry';
  if (s === 'hairdresser' || s === 'beauty' || s === 'barber') return 'salon';
  if (a === 'post_office' || a === 'post_box') return 'post';
  if (a === 'bicycle_parking' || a === 'bicycle_repair_station' || s === 'bicycle' || a === 'bicycle_rental') return 'bike';
  if (a === 'charging_station') return 'ev';
  if (a === 'parking') return 'parking';
  if (a === 'place_of_worship') return 'worship';
  if (a === 'bus_station' || t.highway === 'bus_stop') return 'bus';
  if (t.barrier === 'gate' || t.entrance === 'main') return 'gate';
  if (s) return 'shop';
  if (['pitch', 'sports_centre', 'fitness_centre', 'swimming_pool', 'stadium', 'track'].includes(t.leisure)) return 'sports';
  return null;
}

function spotFromOverture(c, n) {
  const s = (c + ' ' + n).toLowerCase();
  if (/atm|bank/.test(s)) return 'atm';
  if (/pharm|drug|hospital|clinic|doctor|medical|dent|health/.test(s)) return 'medical';
  if (/print|photocopy|copy/.test(s)) return 'print';
  if (/laundr|dry_clean/.test(s)) return 'laundry';
  if (/salon|barber|beauty/.test(s)) return 'salon';
  if (/post_office/.test(s)) return 'post';
  if (/charging/.test(s)) return 'ev';
  if (/bicycle/.test(s)) return 'bike';
  if (/temple|worship|hindu|mosque|church/.test(s)) return 'worship';
  if (/cafe|coffee|tea|restaurant|food|bakery|juice|canteen|pizza|ice_cream/.test(s)) return 'food';
  if (/gym|sport|stadium|swimming/.test(s)) return 'sports';
  if (/bus_st/.test(s)) return 'bus';
  if (/parking/.test(s)) return 'parking';
  if (/store|shop|grocery|convenience|supermarket|market|stationery|book/.test(s)) return 'shop';
  return null;
}

// join member ways of a multipolygon into closed rings of node ids
function joinRings(lists) {
  const pool = lists.filter((l) => l.length > 1).map((l) => l.slice());
  const rings = [];
  while (pool.length) {
    let ring = pool.shift();
    let guard = 0;
    while (ring[0] !== ring[ring.length - 1] && guard++ < 500) {
      const end = ring[ring.length - 1];
      const i = pool.findIndex((w) => w[0] === end || w[w.length - 1] === end);
      if (i < 0) break;
      const w = pool.splice(i, 1)[0];
      ring = ring.concat(w[0] === end ? w.slice(1) : w.slice(0, -1).reverse());
    }
    if (ring.length >= 4 && ring[0] === ring[ring.length - 1]) rings.push(ring);
  }
  return rings;
}

export function buildCampus({ osm, extra = [], places = [], overrides = {}, people = null }) {
  const nodes = new Map(), ways = new Map(), rels = [];
  for (const e of osm.elements) {
    if (e.type === 'node') {
      const old = nodes.get(e.id);
      if (!old || (e.tags && !old.tags)) nodes.set(e.id, e);
    } else if (e.type === 'way') {
      const old = ways.get(e.id);
      if (!old || (e.tags && !old.tags)) ways.set(e.id, e);
    } else if (e.type === 'relation') rels.push(e);
  }
  const xy = new Map();
  const P = (id) => {
    let p = xy.get(id);
    if (!p) { const n = nodes.get(id); if (!n) return null; p = project(n.lat, n.lon); xy.set(id, p); }
    return p;
  };
  const ringOf = (ids) => {
    const r = [];
    for (let i = 0; i < ids.length - 1; i++) { const p = P(ids[i]); if (p) r.push(Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100); }
    return r.length >= 6 ? r : null;
  };
  const lineOf = (ids) => {
    const r = [];
    for (const id of ids) { const p = P(id); if (p) r.push(Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100); }
    return r;
  };
  const orient = (r, outer) => {
    const a = signedArea(r);
    if ((outer && a < 0) || (!outer && a > 0)) {
      const o = [];
      for (let i = r.length - 2; i >= 0; i -= 2) o.push(r[i], r[i + 1]);
      return o;
    }
    return r;
  };
  const ov = overrides.places || {};
  const usedInRel = new Set();
  const polys = []; // {id, tags, rings}
  for (const r of rels) {
    const t = r.tags || {};
    if (t.type !== 'multipolygon' && !t.building) continue;
    const outers = [], inners = [];
    for (const m of r.members || []) {
      if (m.type !== 'way') continue;
      const w = ways.get(m.ref);
      if (!w || !w.nodes) continue;
      (m.role === 'inner' ? inners : outers).push(w.nodes);
      if (!w.tags || Object.keys(w.tags).every((k) => k === 'source' || k === 'area')) usedInRel.add(w.id);
    }
    const ro = joinRings(outers).map(ringOf).filter(Boolean);
    const ri = joinRings(inners).map(ringOf).filter(Boolean);
    for (const outer of ro) {
      const holes = ri.filter((h) => pointInRing(h[0], h[1], outer));
      polys.push({ id: 'r' + r.id, tags: t, rings: [orient(outer, true), ...holes.map((h) => orient(h, false))] });
    }
  }
  for (const w of ways.values()) {
    if (!w.tags || usedInRel.has(w.id) || !w.nodes || w.nodes.length < 4) continue;
    if (w.nodes[0] !== w.nodes[w.nodes.length - 1]) continue;
    const t = w.tags;
    if (t.highway && t.area !== 'yes') continue;
    if (t.barrier && !t.building && !areaKind(t)) continue;
    const r = ringOf(w.nodes);
    if (r) polys.push({ id: 'w' + w.id, tags: t, rings: [orient(r, true)] });
  }

  // campus outline
  let boundary = null;
  const cw = ways.get(621537202);
  if (cw) boundary = orient(ringOf(cw.nodes), true);
  const inCampus = (x, z) => !boundary || pointInRing(x, z, boundary);

  // ---------------------------------------------------------- buildings
  const buildings = [];
  const byName = new Map();
  for (const p of polys) {
    const t = p.tags;
    if (!t.building || t.building === 'no' || t['building:part']) continue;
    const o = ov[t.name] || {};
    const levels = num(t['building:levels']);
    const area = Math.abs(signedArea(p.rings[0]));
    let h = num(t.height);
    const minH = num(t.min_height) || (num(t['building:min_level']) || 0) * 3.2;
    const roofH = num(t['roof:height']);
    if (!h) {
      if (levels) h = levels * 3.2 + (roofH || 0);
      else if (t.building === 'roof') h = 4;
      else if (['shed', 'kiosk', 'garage', 'hut', 'cabin', 'toilets', 'service'].includes(t.building) || area < 40) h = 3.5;
      else h = area < 150 ? 6.5 : area < 800 ? 10 : 12;
    }
    const name = t.name ? (o.name || clean(t.name)) : '';
    const cat = o.cat || classify(t, t.name);
    const [cx, cz] = centroid(p.rings[0]);
    const b = {
      bid: buildings.length, id: p.id, osm: p.id, name, label: o.label || name, short: o.short || '',
      full: clean(t.official_name) && clean(t.official_name) !== name ? clean(t.official_name) : '',
      aka: o.aka || [], cat, sub: o.sub || '', tier: o.tier || (name ? 2 : 0),
      rings: p.rings, area, h: Math.max(h, minH + 2), minH,
      levels: levels || null, floorH: levels ? Math.min(4.2, Math.max(2.8, (h - minH) / levels)) : 3.3,
      wall: t['building:colour'] || null, roof: t['roof:colour'] || null,
      roofShape: t['roof:shape'] || 'flat', roofH: roofH || null,
      roofOnly: t.building === 'roof', shed: t.building === 'shed' || area < 40,
      tags: t, cx, cz, inside: inCampus(cx, cz), extra: false,
    };
    b.windows = !b.roofOnly && !b.shed && b.h > 4.5;
    buildings.push(b);
    if (t.name) { if (!byName.has(t.name)) byName.set(t.name, []); byName.get(t.name).push(b); }
  }
  for (const e of extra) {
    const r = [];
    const ring = e.r;
    for (let i = 0; i < ring.length - 1; i++) { const q = project(ring[i][1], ring[i][0]); r.push(q[0], q[1]); }
    if (r.length < 6) continue;
    const rr = orient(r, true);
    const area = Math.abs(signedArea(rr));
    const [cx, cz] = centroid(rr);
    const h = e.h || (e.f ? e.f * 3.2 : area < 60 ? 3.5 : area < 220 ? 6.5 : area < 700 ? 9.5 : 12);
    buildings.push({
      bid: buildings.length, id: 'x' + buildings.length, osm: null, name: '', label: '', short: '', full: '', aka: [],
      cat: 'other', sub: '', tier: 0, rings: [rr], area, h, minH: 0, levels: e.f || null, floorH: 3.3,
      wall: null, roof: null, roofShape: 'flat', roofH: null, roofOnly: false, shed: area < 40,
      windows: area >= 40 && h > 4.5, tags: {}, cx, cz, inside: inCampus(cx, cz), extra: e.s || true,
    });
  }
  const bGrid = new Grid(50);
  for (const b of buildings) { b.box = bbox(b.rings[0]); bGrid.insertBox(b.box, b); }
  const buildingAt = (x, z) => {
    for (const b of bGrid.query(x, z)) if (x >= b.box[0] && x <= b.box[2] && z >= b.box[1] && z <= b.box[3] && pointInPoly(x, z, b.rings)) return b;
    return null;
  };

  // ---------------------------------------------------------- areas
  const areas = [];
  for (const p of polys) {
    const kind = areaKind(p.tags);
    if (!kind) continue;
    const rings = p.rings.map((r) => (r.length > 40 ? simplify(r, 0.4) : r)).filter((r) => r.length >= 6);
    if (!rings.length) continue;
    const [cx, cz] = centroid(rings[0]);
    areas.push({ id: p.id, kind, sport: p.tags.sport || '', name: p.tags.name ? (ov[p.tags.name]?.name || clean(p.tags.name)) : '', tags: p.tags, rings, cx, cz, area: Math.abs(signedArea(rings[0])) });
  }
  areas.sort((a, b) => b.area - a.area);

  // ---------------------------------------------------------- roads, rails, barriers
  const roads = [], rails = [], barriers = [];
  for (const w of ways.values()) {
    const t = w.tags;
    if (!t || !w.nodes) continue;
    if (t.highway && !NO_ROUTE.has(t.highway) && t.area !== 'yes') {
      const def = ROAD[t.highway];
      if (!def) continue;
      let [kind, width] = def;
      if (t.highway === 'service' && (t.service === 'parking_aisle' || t.service === 'driveway')) width = 3.5;
      if (t.footway === 'sidewalk' || t.footway === 'crossing') width = 2;
      width = num(t.width) || width;
      const pts = lineOf(w.nodes);
      if (pts.length >= 4) roads.push({ id: w.id, kind, hw: t.highway, width, name: t.name || '', pts, nodes: w.nodes, bridge: !!t.bridge && t.bridge !== 'no', layer: num(t.layer) || 0, tunnel: !!t.tunnel && t.tunnel !== 'no' });
    } else if (t.railway === 'rail' || t.railway === 'light_rail') {
      if (!t.tunnel) rails.push({ pts: lineOf(w.nodes), bridge: !!t.bridge });
    } else if (t.barrier && ['wall', 'fence', 'retaining_wall', 'city_wall', 'hedge'].includes(t.barrier)) {
      barriers.push({ kind: t.barrier, pts: lineOf(w.nodes) });
    } else if (t.waterway && ['stream', 'canal', 'drain', 'ditch', 'river'].includes(t.waterway)) {
      barriers.push({ kind: 'water', pts: lineOf(w.nodes), width: t.waterway === 'river' ? 14 : t.waterway === 'canal' ? 8 : 2.5 });
    } else if (t.power === 'line') {
      barriers.push({ kind: 'power', pts: lineOf(w.nodes) });
    }
  }
  if (boundary) barriers.push({ kind: 'campus', pts: [...boundary, boundary[0], boundary[1]] });

  // ---------------------------------------------------------- navigation graph
  const nav = buildNav(roads, nodes, P);

  // ---------------------------------------------------------- places (search + labels + spots)
  const placesOut = [];
  const add = (p) => { p.key = p.id; placesOut.push(p); return p; };
  for (const b of buildings) {
    if (!b.name) continue;
    b.place = add({ id: b.id, kind: 'building', name: b.name, label: b.label, short: b.short, full: b.full, aka: b.aka, cat: b.cat, sub: b.sub, tier: b.tier, x: b.cx, z: b.cz, y: b.h, bid: b.bid, tags: b.tags, spot: spotOf(b.tags, b.sub) });
  }
  for (const a of areas) {
    if (!a.name) continue;
    const o = ov[a.tags.name] || {};
    add({ id: a.id, kind: 'area', name: a.name, label: o.label || a.name, short: o.short || '', full: '', aka: o.aka || [], cat: o.cat || classify(a.tags, a.tags.name), sub: '', tier: o.tier || 3, x: a.cx, z: a.cz, y: 2, tags: a.tags, spot: spotOf(a.tags, '') });
  }
  // unnamed areas that are still useful spots (parking, pitches, pools)
  for (const a of areas) {
    if (a.name) continue;
    const s = spotOf(a.tags, '');
    if (s && inCampus(a.cx, a.cz)) add({ id: a.id, kind: 'area', name: SPOTS[s][0].replace(/ &.*/, ''), label: '', cat: classify(a.tags, ''), aka: [], tier: 9, x: a.cx, z: a.cz, y: 1, tags: a.tags, spot: s, unnamed: true });
  }
  for (const n of nodes.values()) {
    const t = n.tags;
    if (!t) continue;
    const s = spotOf(t, '');
    if (!t.name && !s) continue;
    if (t.entrance && !t.name && t.entrance !== 'main') continue;
    const [x, z] = P(n.id);
    if (!inCampus(x, z) && !t.name) continue;
    const o = ov[t.name] || {};
    const host = buildingAt(x, z);
    add({ id: 'n' + n.id, kind: 'poi', name: t.name ? (o.name || clean(t.name)) : SPOTS[s][0].replace(/ &.*/, ''), label: t.name ? (o.label || clean(t.name)) : '', short: o.short || '', full: '', aka: o.aka || [], cat: o.cat || classify(t, t.name), sub: '', tier: o.tier || (t.name ? 3 : 9), x, z, y: host ? host.h + 1 : 3, tags: t, spot: s, unnamed: !t.name, bid: host ? host.bid : undefined });
  }
  const firstWord = (n) => (n || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').split(' ').find((w) => w.length >= 3 && !['the', 'iit', 'new'].includes(w)) || '';
  places.forEach((q, i) => {
    const [x, z] = project(q.lat, q.lon);
    const name = (q.n || '').split(/\s+[|,]\s+/)[0].slice(0, 40);
    const fw = firstWord(name);
    if (fw && placesOut.some((p) => !p.unnamed && firstWord(p.name) === fw && Math.hypot(p.x - x, p.z - z) < 150)) return; // already on OSM
    const s = spotFromOverture(q.c || '', q.n || '');
    const host = buildingAt(x, z);
    add({ id: 'o' + i, kind: 'poi', name, label: name, short: '', full: q.n !== name ? q.n : '', aka: [], cat: classify({ amenity: q.c }, q.n), sub: '', tier: 4, x, z, y: host ? host.h + 1 : 3, tags: { website: q.web }, spot: s, src: 'overture', bid: host ? host.bid : undefined });
  });

  // faculty -> building
  const persons = [];
  if (people && people.items) {
    const codes = overrides.roomCodes || {};
    const schools = overrides.schools || {};
    const firstBuilding = (osmName) => (byName.get(osmName) || [])[0];
    for (const it of people.items) {
      let host = null, via = 'school';
      const room = it.o || '';
      const up = room.toUpperCase();
      for (const code of Object.keys(codes)) {
        if (new RegExp('(^|[^A-Z])' + code.replace(/ /g, '\\s*') + '([^A-Z]|$)').test(up)) { host = firstBuilding(codes[code]); via = 'room'; if (host) break; }
      }
      if (!host) host = firstBuilding(schools[it.s]);
      const slug = it.n.toLowerCase().replace(/^(dr|prof|mr|ms|mrs)\.?\s+/g, '').replace(/[^a-z0-9]+/g, '-');
      const p = { id: 'p:' + slug, kind: 'person', name: it.n, title: it.t || '', school: it.s || '', email: it.e || '', phone: it.ph || '', url: it.u || '', room, via, cat: 'academic', tier: 99, aka: [] };
      if (host) { p.bid = host.bid; p.x = host.cx; p.z = host.cz; p.y = host.h; p.building = host.name; }
      persons.push(p);
    }
  }

  // extent of things worth looking at
  const ext = boundary ? bbox(boundary) : [-1500, -1000, 1500, 1000];
  return { buildings, areas, roads, rails, barriers, boundary, places: placesOut, persons, nav, ext, buildingAt, bGrid, inCampus };
}

// ------------------------------------------------------------------ graph
function buildNav(roads, nodes, P) {
  const index = new Map(); // osm node id -> graph index
  const X = [], Z = [], adj = [];
  const nid = (id) => {
    let i = index.get(id);
    if (i === undefined) {
      const p = P(id); if (!p) return -1;
      i = X.length; index.set(id, i); X.push(p[0]); Z.push(p[1]); adj.push([]);
    }
    return i;
  };
  const edges = []; // [a, b, len, roadIdx]
  roads.forEach((r, ri) => {
    if (r.tunnel && r.kind === 'corridor') return;
    for (let k = 1; k < r.nodes.length; k++) {
      const a = nid(r.nodes[k - 1]), b = nid(r.nodes[k]);
      if (a < 0 || b < 0 || a === b) continue;
      const len = Math.hypot(X[a] - X[b], Z[a] - Z[b]);
      adj[a].push([b, len, ri]); adj[b].push([a, len, ri]);
      edges.push([a, b, len, ri]);
    }
  });
  // stitch small gaps: dead ends within 18 m of another component
  const comp = components(adj);
  const g = new Grid(30);
  for (let i = 0; i < X.length; i++) g.insertBox([X[i], Z[i], X[i], Z[i]], i);
  let added = 0;
  for (let i = 0; i < X.length; i++) {
    if (adj[i].length !== 1) continue;
    let best = -1, bd = 18;
    for (const j of g.queryBox([X[i] - 18, Z[i] - 18, X[i] + 18, Z[i] + 18])) {
      if (comp[j] === comp[i]) continue;
      const d = Math.hypot(X[i] - X[j], Z[i] - Z[j]);
      if (d < bd) { bd = d; best = j; }
    }
    if (best >= 0) { adj[i].push([best, bd * 1.3, -1]); adj[best].push([i, bd * 1.3, -1]); edges.push([i, best, bd * 1.3, -1]); added++; }
  }
  const comp2 = components(adj);
  const size = new Map();
  for (const c of comp2) size.set(c, (size.get(c) || 0) + 1);
  let main = -1, ms = 0;
  for (const [c, s] of size) if (s > ms) { ms = s; main = c; }
  const eGrid = new Grid(40);
  edges.forEach((e, k) => { if (comp2[e[0]] === main || size.get(comp2[e[0]]) > 25) eGrid.insertBox([Math.min(X[e[0]], X[e[1]]), Math.min(Z[e[0]], Z[e[1]]), Math.max(X[e[0]], X[e[1]]), Math.max(Z[e[0]], Z[e[1]])], k); });
  return { X, Z, adj, edges, eGrid, comp: comp2, main, stitched: added };
}

function components(adj) {
  const c = new Int32Array(adj.length).fill(-1);
  let k = 0;
  for (let i = 0; i < adj.length; i++) {
    if (c[i] >= 0) continue;
    const st = [i]; c[i] = k;
    while (st.length) { const u = st.pop(); for (const [v] of adj[u]) if (c[v] < 0) { c[v] = k; st.push(v); } }
    k++;
  }
  return c;
}

// nearest point on the walkable network
export function snap(nav, x, z, maxR = 1300) {
  let best = null;
  for (let r = 40; r <= maxR && !best; r *= 2) {
    let bd = Infinity;
    for (const k of nav.eGrid.queryBox([x - r, z - r, x + r, z + r])) {
      const e = nav.edges[k];
      const c = closestOnSeg(x, z, nav.X[e[0]], nav.Z[e[0]], nav.X[e[1]], nav.Z[e[1]]);
      if (c[3] < bd) { bd = c[3]; best = { e: k, a: e[0], b: e[1], t: c[2], x: c[0], z: c[1], d: Math.sqrt(c[3]) }; }
    }
  }
  return best;
}

// where to leave the network for a building: the road point closest to its walls
export function accessPoint(nav, b) {
  let best = null;
  const r = b.rings[0];
  const box = [b.box[0] - 80, b.box[1] - 80, b.box[2] + 80, b.box[3] + 80];
  for (const k of nav.eGrid.queryBox(box)) {
    const e = nav.edges[k];
    const ax = nav.X[e[0]], az = nav.Z[e[0]], bx = nav.X[e[1]], bz = nav.Z[e[1]];
    for (let i = 0; i < r.length; i += 2) {
      const c = closestOnSeg(r[i], r[i + 1], ax, az, bx, bz);
      const d = Math.sqrt(c[3]);
      if (!best || d < best.d) best = { e: k, a: e[0], b: e[1], t: c[2], x: c[0], z: c[1], d, wx: r[i], wz: r[i + 1] };
    }
  }
  if (!best) return snap(nav, b.cx, b.cz);
  if (best) {
    const [, wx, wz] = distToRing(best.x, best.z, r);
    best.wx = wx; best.wz = wz;
  }
  return best;
}

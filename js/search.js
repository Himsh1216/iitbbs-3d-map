// Small fuzzy search over places, people and useful-spot categories.
import { SPOTS, CATS } from './osm.js';

export const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ').replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

const SPOT_WORDS = {
  water: 'water drinking water water cooler ro filter', toilets: 'toilet toilets washroom restroom bathroom loo',
  atm: 'atm bank cash sbi', food: 'food canteen cafe mess restaurant eat snacks tea coffee juice night canteen',
  shop: 'shop store market stationery grocery general store', medical: 'medical pharmacy hospital doctor health centre chemist medicine dispensary',
  print: 'print photocopy xerox printout copy', laundry: 'laundry dhobi wash clothes dry clean', salon: 'salon barber haircut parlour',
  post: 'post office post courier', bike: 'cycle bicycle cycle repair cycle parking puncture', ev: 'ev charging charging electric vehicle',
  lecture: 'lecture hall lh classroom', sports: 'sports ground gym court pool swimming stadium', parking: 'parking car park',
  worship: 'temple mandir worship', gate: 'gate main gate entry exit', bus: 'bus bus stop shuttle',
};

function lev1(a, b) { // true if edit distance <= 1
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, e = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++e > 1) return false;
    if (a.length > b.length) i++; else if (a.length < b.length) j++; else { i++; j++; }
  }
  return e + (a.length - i) + (b.length - j) <= 1;
}

function scoreField(s, q, qt) {
  if (!s) return 0;
  if (s === q) return 100;
  if (s.startsWith(q)) return 82;
  const words = s.split(' ');
  if (words.some((w) => w.startsWith(q))) return 66;
  if (qt.length > 1 && qt.every((t) => words.some((w) => w.startsWith(t)))) return 60;
  if (q.length >= 3 && s.includes(q)) return 50;
  if (q.length >= 2 && !q.includes(' ')) { const ini = words.map((w) => w[0]).join(''); if (ini.startsWith(q)) return 46; }
  if (q.length >= 4 && qt.length === 1 && words.some((w) => w.length >= 4 && lev1(w.slice(0, Math.max(q.length, w.length)), q))) return 34;
  return 0;
}

export class Search {
  constructor(model) {
    this.items = [];
    for (const p of model.places) {
      if (p.unnamed) continue;
      this.items.push({ ref: p, f: [[norm(p.name), 1], [norm(p.short), 1], [norm(p.label), 0.95], ...p.aka.map((a) => [norm(a), 0.88]), [norm(p.full), 0.85], [norm(CATS[p.cat]?.label), 0.4]], boost: p.tier === 1 ? 6 : p.tier === 2 ? 3 : 0 });
    }
    for (const p of model.persons) {
      const n = norm(p.name.replace(/^(dr|prof|mr|ms|mrs)\.?\s+/i, ''));
      this.items.push({ ref: p, f: [[n, 1], [norm(p.school), 0.35], [norm(p.room), 0.5]], boost: -3 });
    }
    for (const id in SPOTS) {
      const count = model.places.filter((p) => p.spot === id).length;
      this.items.push({ ref: { kind: 'spot', id: 'spot:' + id, spot: id, name: SPOTS[id][0], icon: SPOTS[id][1], count }, f: [[norm(SPOTS[id][0]), 1], [SPOT_WORDS[id], 0.92]], boost: count ? 2 : -6 });
    }
  }
  query(text, limit = 12) {
    const q = norm(text);
    if (!q) return [];
    const qt = q.split(' ');
    const out = [];
    for (const it of this.items) {
      let best = 0;
      for (const [s, w] of it.f) { const v = scoreField(s, q, qt) * w; if (v > best) best = v; }
      if (best > 0) out.push([best + it.boost, it.ref]);
    }
    out.sort((a, b) => b[0] - a[0]);
    const seen = new Set(), res = [];
    for (const [, r] of out) {
      const k = r.kind + ':' + r.name + ':' + (r.kind === 'person' ? r.id : Math.round((r.x || 0) / 60) + ',' + Math.round((r.z || 0) / 60));
      if (seen.has(k)) continue; seen.add(k); res.push(r);
      if (res.length >= limit) break;
    }
    return res;
  }
}

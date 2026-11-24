#!/usr/bin/env python3
"""Fetch the data files the IIT Bhubaneswar 3D map loads.

Writes into the output folder (default: data/):
  osm.json              raw Overpass answer for the campus (OpenStreetMap, ODbL)
  extra-buildings.json  footprints OSM is still missing (Overture Maps buildings)
  places.json           extra points of interest (Overture Maps places)
  people.json           faculty, school and office room (iitbbs.ac.in directory)
  meta.json             when each file was fetched and how many items it has

Every step is fail-soft: if a source is down, the copy already published on the
live site is reused; if there is none, the file is skipped and the app copes.
Run:  python3 scripts/build_data.py --out data
"""
import argparse, datetime, html, json, math, os, re, socket, subprocess, sys, tempfile, time
import urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
UA = "iitbbs-3d-map data builder (+https://github.com/Himsh1216/iitbbs-3d-map)"
OVERPASS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
# west, south, east, north of the area around campus
BBOX = (85.6525, 20.1371, 85.6877, 20.1588)
FACULTY_URL = "https://www.iitbbs.ac.in/index.php/faculty-members/"
CAMPUS_WAY = 621537202


# GitHub's runners have no IPv6 route: try IPv4 addresses first
_getaddrinfo = socket.getaddrinfo
socket.getaddrinfo = lambda *a, **k: sorted(_getaddrinfo(*a, **k), key=lambda r: r[0] != socket.AF_INET)


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def http(url, data=None, timeout=200):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def write_json(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))


def previous(prev_site, name, dest):
    """Reuse the copy from the live site when a source is down."""
    if not prev_site:
        return False
    try:
        raw = http(prev_site.rstrip("/") + "/data/" + name, timeout=60)
        json.loads(raw)
        with open(dest, "wb") as f:
            f.write(raw)
        log(f"  reused previous {name} ({len(raw)//1024} KB)")
        return True
    except Exception as e:  # noqa: BLE001
        log(f"  no previous {name}: {e}")
        return False


# ---------------------------------------------------------------- OSM
def fetch_osm():
    query = open(os.path.join(HERE, "campus.overpassql"), encoding="utf-8").read()
    body = urllib.parse.urlencode({"data": query}).encode()
    deadline = time.time() + 540
    for attempt in range(3):
        for url in OVERPASS:
            if time.time() > deadline:
                return None
            try:
                log(f"  overpass: {url}")
                raw = http(url, data=body, timeout=150)
                data = json.loads(raw)
                n = len(data.get("elements", []))
                if n < 500:
                    raise ValueError(f"only {n} elements")
                if data.get("remark"):
                    raise ValueError(data["remark"][:200])
                return data
            except Exception as e:  # noqa: BLE001
                log(f"    failed: {e}")
        time.sleep(45)
    return None


def osm_polygons(osm):
    """Building footprints from the Overpass answer as lists of (lon, lat) rings."""
    nodes, ways, out = {}, {}, []
    for e in osm["elements"]:
        if e["type"] == "node":
            nodes[e["id"]] = (e["lon"], e["lat"])
        elif e["type"] == "way":
            ways.setdefault(e["id"], e)
    for e in osm["elements"]:
        t = e.get("tags") or {}
        if "building" not in t and "building:part" not in t:
            continue
        if e["type"] == "way":
            ring = [nodes[n] for n in e.get("nodes", []) if n in nodes]
            if len(ring) >= 4:
                out.append(ring)
        elif e["type"] == "relation":
            for m in e.get("members", []):
                w = ways.get(m["ref"]) if m["type"] == "way" and m.get("role") != "inner" else None
                if w:
                    ring = [nodes[n] for n in w.get("nodes", []) if n in nodes]
                    if len(ring) >= 4 and ring[0] == ring[-1]:
                        out.append(ring)
    return out


def campus_outline(osm):
    nodes = {e["id"]: (e["lon"], e["lat"]) for e in osm["elements"] if e["type"] == "node"}
    for e in osm["elements"]:
        if e["type"] == "way" and e["id"] == CAMPUS_WAY:
            return [nodes[n] for n in e["nodes"] if n in nodes]
    return None


# ---------------------------------------------------------------- Overture
def overture(kind):
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, kind + ".geojson")
        cmd = ["overturemaps", "download", "--bbox=%f,%f,%f,%f" % BBOX, "-f", "geojson", "-t", kind, "-o", path]
        log("  " + " ".join(cmd))
        subprocess.run(cmd, check=True, timeout=900)
        with open(path, encoding="utf-8") as f:
            return json.load(f)["features"]


def as_obj(v):
    if isinstance(v, str):
        try:
            return json.loads(v)
        except ValueError:
            return v
    return v


def extra_buildings(osm):
    from shapely.geometry import Polygon, shape
    from shapely.strtree import STRtree
    from shapely.validation import make_valid

    k = math.cos(math.radians(20.148))
    def local(geom):  # degrees -> roughly metres, for areas and overlaps
        from shapely import affinity
        return affinity.scale(geom, xfact=111320 * k, yfact=110574, origin=(85.67, 20.148))

    osm_polys = []
    for ring in osm_polygons(osm):
        try:
            p = make_valid(local(Polygon(ring)))
            if p.area > 1:
                osm_polys.append(p)
        except Exception:  # noqa: BLE001
            pass
    tree = STRtree(osm_polys)
    out, skipped = [], 0
    for f in overture("building"):
        props = f.get("properties") or {}
        sources = as_obj(props.get("sources")) or []
        datasets = {s.get("dataset", "") for s in sources if isinstance(s, dict)}
        if any("OpenStreetMap" in d for d in datasets):
            skipped += 1
            continue
        conf = [s.get("confidence") for s in sources if isinstance(s, dict) and s.get("confidence") is not None]
        if conf and max(conf) < 0.7:
            continue
        g = f.get("geometry") or {}
        if g.get("type") not in ("Polygon", "MultiPolygon"):
            continue
        geom = shape(g)
        polys = [geom] if geom.geom_type == "Polygon" else list(geom.geoms)
        for poly in polys:
            loc = make_valid(local(poly))
            if not (12 <= loc.area <= 25000):
                continue
            hit = False
            for i in tree.query(loc):
                o = osm_polys[int(i)]
                inter = loc.intersection(o).area
                if inter > 0.25 * min(loc.area, o.area):
                    hit = True
                    break
            if hit:
                continue
            ring = [[round(x, 6), round(y, 6)] for x, y in poly.exterior.coords]
            item = {"r": ring}
            if props.get("height"):
                item["h"] = round(float(props["height"]), 1)
            if props.get("num_floors"):
                item["f"] = int(props["num_floors"])
            src = next(iter(datasets), "")
            item["s"] = "g" if "Google" in src else "m" if "Microsoft" in src else "e" if "Esri" in src else "o"
            out.append(item)
    log(f"  overture buildings kept: {len(out)} (skipped {skipped} already from OSM)")
    return out


PLACE_KEEP = re.compile(
    r"atm|bank|cafe|coffee|tea|restaurant|food|bakery|juice|canteen|fast_food|pizza|ice_cream|"
    r"pharmacy|drugstore|hospital|clinic|doctor|medical|dentist|health|post_office|"
    r"salon|barber|beauty|laundry|dry_clean|print|photocopy|copy|stationery|book|"
    r"grocery|convenience|supermarket|market|store|shop|gym|sports|stadium|swimming|"
    r"temple|place_of_worship|hindu|mosque|church|charging|bicycle|library|auditorium|"
    r"guest_house|hostel|parking|bus_station|bus_stop|police|fire_station",
    re.I,
)


def extra_places(osm):
    from shapely.geometry import Point, Polygon
    outline = campus_outline(osm)
    area = Polygon(outline).buffer(0.0006) if outline else None
    out = []
    for f in overture("place"):
        props = f.get("properties") or {}
        g = f.get("geometry") or {}
        if g.get("type") != "Point":
            continue
        lon, lat = g["coordinates"][:2]
        if area is not None and not area.contains(Point(lon, lat)):
            continue
        conf = props.get("confidence")
        if conf is not None and float(conf) < 0.5:
            continue
        names = as_obj(props.get("names")) or {}
        name = names.get("primary") if isinstance(names, dict) else None
        cats = as_obj(props.get("categories")) or {}
        cat = (cats.get("primary") if isinstance(cats, dict) else None) or props.get("basic_category") or ""
        if not name or not PLACE_KEEP.search(cat + " " + name):
            continue
        item = {"n": name, "c": cat, "lat": round(lat, 6), "lon": round(lon, 6)}
        sites = as_obj(props.get("websites"))
        if isinstance(sites, list) and sites:
            item["web"] = sites[0]
        out.append(item)
    log(f"  overture places kept: {len(out)}")
    return out


# ---------------------------------------------------------------- faculty
def text_of(cell):
    cell = re.sub(r"<br\s*/?>", " / ", cell, flags=re.I)
    cell = re.sub(r"<[^>]+>", " ", cell)
    return re.sub(r"\s+", " ", html.unescape(cell)).strip(" -/")


def parse_faculty_table(page):
    rows = []
    start = page.find("Faculty Name")
    table = page[start: page.find("</table>", start)] if start >= 0 else ""
    for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", table, flags=re.S | re.I):
        cells = re.findall(r"<td[^>]*>(.*?)</td>", tr, flags=re.S | re.I)
        if len(cells) < 5:
            continue
        link = re.search(r'href="([^"]+)"', cells[5] if len(cells) > 5 else "")
        name = text_of(cells[0])
        if not name:
            continue
        item = {"n": name, "t": text_of(cells[1]), "s": text_of(cells[2])}
        phone, email = text_of(cells[3]), text_of(cells[4])
        if phone and phone != "-":
            item["ph"] = phone
        if email and email != "-":
            item["e"] = email
        if link:
            item["u"] = html.unescape(link.group(1))
        rows.append(item)
    return rows


def parse_room(page):
    m = re.search(r"map-pin.{0,1500}?elementor-icon-list-text[^>]*>(.*?)</span>", page, flags=re.S | re.I)
    room = text_of(m.group(1)) if m else ""
    if not room:
        m = re.search(r"(Room\s*(?:No\.?|Number)?\s*[:.\-]?\s*[A-Za-z0-9][^<\n]{0,40})", page, flags=re.I)
        room = text_of(m.group(1)) if m else ""
    room = room.strip(" .,")
    if len(room) > 60 or "@" in room:
        return ""
    return room


def fetch_people(budget=420):
    from concurrent.futures import ThreadPoolExecutor, as_completed
    page = http(FACULTY_URL, timeout=90).decode("utf-8", "replace")
    rows = parse_faculty_table(page)
    if len(rows) < 50:
        raise ValueError(f"only {len(rows)} faculty rows")
    log(f"  faculty rows: {len(rows)}")
    t0, dead, done, found = time.time(), set(), 0, 0

    def room_for(row):
        host = urllib.parse.urlparse(row["u"]).netloc
        if host in dead or time.time() - t0 > budget:
            return row, None
        try:
            return row, parse_room(http(row["u"], timeout=20).decode("utf-8", "replace"))
        except Exception as e:  # noqa: BLE001
            if "Name or service not known" in str(e):
                dead.add(host)
            return row, None

    with ThreadPoolExecutor(max_workers=8) as pool:
        for fut in as_completed([pool.submit(room_for, r) for r in rows if r.get("u")]):
            row, room = fut.result()
            done += 1
            if room:
                row["o"] = room
                found += 1
            if done % 40 == 0:
                log(f"    profiles {done}, rooms {found}, {time.time() - t0:.0f}s")
    log(f"  office rooms found: {found} of {len(rows)} ({time.time() - t0:.0f}s)")
    return {"src": FACULTY_URL, "fetched": datetime.date.today().isoformat(), "items": rows}


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(HERE, "..", "data"))
    ap.add_argument("--prev-site", default=os.environ.get("PREV_SITE", ""))
    ap.add_argument("--skip", default="", help="comma list: osm,buildings,places,people")
    ap.add_argument("--reuse", action="store_true", help="reuse files already on the live site (fast code-only deploys)")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    skip = set(filter(None, a.skip.split(",")))
    meta = {"built": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="minutes")}
    p = lambda n: os.path.join(a.out, n)  # noqa: E731
    files = {"osm": "osm.json", "buildings": "extra-buildings.json", "places": "places.json", "people": "people.json"}

    if a.reuse and a.prev_site:
        log("Reusing the data already published")
        try:
            meta.update({k: v for k, v in json.loads(http(a.prev_site.rstrip("/") + "/data/meta.json", timeout=60)).items() if k != "built"})
        except Exception as e:  # noqa: BLE001
            log(f"  no previous meta.json: {e}")
        for key, name in files.items():
            if key not in skip and previous(a.prev_site, name, p(name)):
                skip.add(key)

    osm = None
    if "osm" not in skip:
        log("OpenStreetMap")
        osm = fetch_osm()
        if osm:
            write_json(p("osm.json"), osm)
            meta["osm"] = {"fetched": meta["built"], "elements": len(osm["elements"])}
        elif previous(a.prev_site, "osm.json", p("osm.json")):
            meta["osm"] = {"reused": True}
    if osm is None and os.path.exists(p("osm.json")):
        osm = json.load(open(p("osm.json"), encoding="utf-8"))

    for name, fn, key in (("extra-buildings.json", extra_buildings, "buildings"),
                          ("places.json", extra_places, "places")):
        if key in skip or osm is None:
            continue
        log("Overture " + key)
        try:
            items = fn(osm)
            write_json(p(name), items)
            meta[key] = {"fetched": meta["built"], "count": len(items)}
        except Exception as e:  # noqa: BLE001
            log(f"  failed: {e}")
            if previous(a.prev_site, name, p(name)):
                meta[key] = {"reused": True}

    if "people" not in skip:
        log("Faculty directory")
        try:
            people = fetch_people()
            write_json(p("people.json"), people)
            meta["people"] = {"fetched": people["fetched"], "count": len(people["items"])}
        except Exception as e:  # noqa: BLE001
            log(f"  failed: {e}")
            if previous(a.prev_site, "people.json", p("people.json")):
                meta["people"] = {"reused": True}

    write_json(p("meta.json"), meta)
    log(json.dumps(meta))


if __name__ == "__main__":
    main()

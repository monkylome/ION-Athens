#!/usr/bin/env python3
"""Build presentation/athens-scene.js from the team's OpenStreetMap data.

Reads data/raw/athens-centre.osmapi/*.json.gz (buildings, roads, trees, kiosks,
cafes, crossings) and data/athens-centre.graph.json (the pedestrian graph), and
writes one JavaScript file that defines window.ATHENS_SCENE. A classic script is
used so the presentation also opens from file://.

The routes are computed on the real graph: route A is the shortest walk from
Monastiraki to the City Hall on Athinas; one edge of route A is closed by a
scaffold, and route B is the shortest walk with that edge removed. The decision
point is where B leaves A.

Coordinates are metres in a local frame: x east, z south, origin at ORIGIN.
Data: © OpenStreetMap contributors, ODbL 1.0.

Run from the repository root:  python3 presentation/tools/build-scene.py
"""
import glob
import gzip
import heapq
import json
import math
import os
import random

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "presentation", "athens-scene.js")

ORIGIN = (37.9790, 23.7265)  # lat, lng: between Monastiraki and Kotzia
BBOX = (37.9738, 23.7205, 37.9845, 23.7335)  # south, west, north, east
START_NODE = "n12843875721"  # Monastiraki metro entrance on the square
TOWNHALL_WAY = 768849988
DEST_NODE = "n6693647613"  # graph node on Athinas in front of the City Hall

COS = math.cos(math.radians(ORIGIN[0]))


def to_xz(lat, lng):
    return (round((lng - ORIGIN[1]) * 111320 * COS, 2), round(-(lat - ORIGIN[0]) * 110540, 2))


def inside(lat, lng, pad=0.0):
    s, w, n, e = BBOX
    return s - pad <= lat <= n + pad and w - pad <= lng <= e + pad


ROAD_WIDTH = {
    "trunk": 14, "primary": 12, "primary_link": 8, "secondary": 10, "secondary_link": 7,
    "tertiary": 8, "tertiary_link": 6, "unclassified": 6, "residential": 6,
    "living_street": 5, "service": 4,
}
PED_WIDTH = {"pedestrian": 6, "footway": 2.2, "steps": 2.5}


def load_osm():
    els = {}
    for f in sorted(glob.glob(os.path.join(ROOT, "data/raw/athens-centre.osmapi/*.json.gz"))):
        with gzip.open(f) as fh:
            for e in json.load(fh)["elements"]:
                els[(e["type"], e["id"])] = e
    nodes = {i: (e["lat"], e["lon"]) for (t, i), e in els.items() if t == "node" and "lat" in e}
    return els, nodes


def poly_area(pts):
    a = 0.0
    for i in range(len(pts)):
        x1, z1 = pts[i]
        x2, z2 = pts[(i + 1) % len(pts)]
        a += x1 * z2 - x2 * z1
    return a / 2


def seg_dist(px, pz, ax, az, bx, bz):
    dx, dz = bx - ax, bz - az
    L = dx * dx + dz * dz
    t = 0 if L == 0 else max(0, min(1, ((px - ax) * dx + (pz - az) * dz) / L))
    cx, cz = ax + t * dx, az + t * dz
    return math.hypot(px - cx, pz - cz), cx, cz


class Grid:
    """Road segments in 25 m cells, for 'nearest road' questions."""

    def __init__(self, size=25):
        self.size, self.cells = size, {}

    def add(self, seg):
        (ax, az), (bx, bz) = seg[0], seg[1]
        for gx in range(int(min(ax, bx) // self.size) - 1, int(max(ax, bx) // self.size) + 2):
            for gz in range(int(min(az, bz) // self.size) - 1, int(max(az, bz) // self.size) + 2):
                self.cells.setdefault((gx, gz), []).append(seg)

    def nearest(self, x, z):
        best = None
        for seg in self.cells.get((int(x // self.size), int(z // self.size)), []):
            d, cx, cz = seg_dist(x, z, *seg[0], *seg[1])
            if best is None or d < best[0]:
                best = (d, cx, cz, seg)
        return best


def main():
    rnd = random.Random(7)
    els, nodes = load_osm()

    buildings, roads, areas, hall = [], [], [], None
    grid = Grid()
    for (t, i), e in els.items():
        if t != "way":
            continue
        tg = e.get("tags", {})
        ids = e.get("nodes", [])
        pts_ll = [nodes[n] for n in ids if n in nodes]
        if len(pts_ll) < 2 or not any(inside(*p, 0.0003) for p in pts_ll):
            continue
        pts = [to_xz(*p) for p in pts_ll]
        hw = tg.get("highway")
        if "building" in tg and ids[0] == ids[-1] and len(pts) >= 4:
            ring = pts[:-1]
            area = abs(poly_area(ring))
            if area < 12:
                continue
            if "height" in tg:
                try:
                    h = float(tg["height"].split()[0])
                except ValueError:
                    h = None
            else:
                h = None
            if h is None and "building:levels" in tg:
                try:
                    h = float(tg["building:levels"]) * 3.3 + 0.6
                except ValueError:
                    h = None
            if h is None:
                h = (4 + rnd.randint(0, 3)) * 3.3 + 0.6
            kind = "church" if tg.get("building") == "church" or tg.get("amenity") == "place_of_worship" else "b"
            if kind == "church":
                h = min(h, 11)
            if i == TOWNHALL_WAY:
                hall = {"h": round(h, 1), "pts": ring}
                continue
            buildings.append([round(h, 1), kind, [c for p in ring for c in p]])
        elif hw in ROAD_WIDTH:
            w = ROAD_WIDTH[hw]
            roads.append([hw, w, [c for p in pts for c in p], tg.get("name", "")])
            for a, b in zip(pts, pts[1:]):
                grid.add((a, b, w, hw))
        elif hw in PED_WIDTH and tg.get("area") != "yes":
            roads.append([hw, PED_WIDTH[hw], [c for p in pts for c in p], tg.get("name", "")])
        elif ids[0] == ids[-1] and (
            (hw == "pedestrian" and tg.get("area") == "yes") or tg.get("place") == "square"
        ):
            areas.append(["plaza", [c for p in pts[:-1] for c in p]])
        elif ids[0] == ids[-1] and (tg.get("leisure") == "park" or tg.get("landuse") in ("grass", "park")):
            areas.append(["green", [c for p in pts[:-1] for c in p]])

    # Shop fronts: building walls that face a road within a few metres.
    fronts = []
    for h, kind, flat in buildings:
        ring = list(zip(flat[0::2], flat[1::2]))
        sign = 1 if poly_area(ring) > 0 else -1
        for (ax, az), (bx, bz) in zip(ring, ring[1:] + ring[:1]):
            L = math.hypot(bx - ax, bz - az)
            if L < 3.5:
                continue
            mx, mz = (ax + bx) / 2, (az + bz) / 2
            # Outward normal for this winding (x east, z south).
            nx, nz = (bz - az) / L * sign, -(bx - ax) / L * sign
            hit = grid.nearest(mx + nx * 2, mz + nz * 2)
            if not hit:
                continue
            d, _, _, seg = hit
            if d < seg[2] / 2 + 6:
                fronts.append([round(ax, 2), round(az, 2), round(bx, 2), round(bz, 2), round(nx, 3), round(nz, 3)])

    # Point features.
    trees, kiosks, cafes, crossings = [], [], [], []
    for (t, i), e in els.items():
        if t != "node" or not inside(e["lat"], e["lon"]):
            continue
        tg = e.get("tags", {})
        x, z = to_xz(e["lat"], e["lon"])
        if tg.get("natural") == "tree":
            trees.append([x, z])
        elif tg.get("shop") == "kiosk":
            kiosks.append([x, z])
        elif tg.get("amenity") in ("cafe", "restaurant", "bar", "fast_food"):
            hit = grid.nearest(x, z)
            if hit and hit[0] < 25:
                d, cx, cz, seg = hit
                # Tables on the pavement, between the door and the kerb.
                half = seg[2] / 2
                ux, uz = (x - cx) / max(d, 0.01), (z - cz) / max(d, 0.01)
                tx, tz = cx + ux * (half + 1.6), cz + uz * (half + 1.6)
                (ax, az), (bx, bz) = seg[0], seg[1]
                ang = math.atan2(bx - ax, bz - az)
                cafes.append([round(tx, 2), round(tz, 2), round(ang, 3)])
        elif tg.get("highway") == "crossing":
            hit = grid.nearest(x, z)
            if hit and hit[0] < 4:
                (ax, az), (bx, bz) = hit[3][0], hit[3][1]
                crossings.append([x, z, round(math.atan2(bx - ax, bz - az), 3), hit[3][2]])

    # Routes on the real pedestrian graph.
    g = json.load(open(os.path.join(ROOT, "data/athens-centre.graph.json")))
    gn = {n["id"]: (n["lat"], n["lng"]) for n in g["nodes"]}
    adj = {}
    edges = {}
    for e in g["edges"]:
        edges[e["id"]] = e
        adj.setdefault(e["from"], []).append((e["to"], e["id"]))
        adj.setdefault(e["to"], []).append((e["from"], e["id"]))
    extras = json.load(open(os.path.join(ROOT, "data/athens-centre.extras.json")))
    ways = extras.get("ways", {})

    def edge_cost(e):
        c = e["lengthM"]
        if e["kind"] == "shared_road":
            hwy = ways.get(e["id"][1:].split("-")[0], {}).get("highway", "")
            c *= {"primary": 1.6, "secondary": 1.4, "trunk": 2.0}.get(hwy, 1.15)
        if e["kind"] == "steps":
            c *= 3
        return c

    def dijkstra(src, dst, banned=frozenset()):
        dist, prev, pq = {src: 0}, {}, [(0, src)]
        while pq:
            d, u = heapq.heappop(pq)
            if u == dst:
                break
            if d > dist[u]:
                continue
            for v, eid in adj.get(u, []):
                if eid in banned:
                    continue
                nd = d + edge_cost(edges[eid])
                if nd < dist.get(v, 1e18):
                    dist[v], prev[v] = nd, (u, eid)
                    heapq.heappush(pq, (nd, v))
        path, u = [], dst
        while u != src:
            if u not in prev:
                return None
            p, eid = prev[u]
            path.append((p, u, eid))
            u = p
        return list(reversed(path))

    def length(p):
        return sum(edges[e]["lengthM"] for _, _, e in p)

    def closed_at(mx, mz, radius=28):
        """Every edge with a point within `radius` metres of the scaffold.

        Closing only the scaffold's own pavement sends the detour to the opposite pavement of
        the same street, which does not read as a detour. The works close the street block:
        both pavements, the road and the crossings next to it.
        """
        closed = set()
        for other_id, o in edges.items():
            for lng, lat in o["geometry"]:
                x, z = to_xz(lat, lng)
                if abs(x - mx) < radius and abs(z - mz) < radius and math.hypot(x - mx, z - mz) < radius:
                    closed.add(other_id)
                    break
        return frozenset(closed)

    def point_on(steps, s):
        """The (x, z) point s metres along the steps, and the step it falls on."""
        for k, (u, v, eid) in enumerate(steps):
            e = edges[eid]
            if s <= e["lengthM"] or k == len(steps) - 1:
                geo = e["geometry"] if e["from"] == u else list(reversed(e["geometry"]))
                pts = [to_xz(lat, lng) for lng, lat in geo]
                for (ax, az), (bx, bz) in zip(pts, pts[1:]):
                    L = math.hypot(bx - ax, bz - az)
                    if s <= L:
                        f = s / L if L else 0
                        return (ax + (bx - ax) * f, az + (bz - az) * f), k
                    s -= L
                return pts[-1], k
            s -= e["lengthM"]

    A = dijkstra(START_NODE, DEST_NODE)
    total = length(A)
    # Try the scaffold every 8 m along the middle of route A, and keep the spot that is
    # closest past the decision corner (at least 25 m, so it is seen coming).
    best = None
    s = 0.4 * total
    while s < 0.75 * total:
        (mx, mz), k = point_on(A, s)
        B = dijkstra(START_NODE, DEST_NODE, closed_at(mx, mz))
        if B:
            common = 0
            while common < min(len(A), len(B)) and A[common][2] == B[common][2]:
                common += 1
            ahead = s - length(A[:common])
            ratio = length(B) / total
            if 1.01 < ratio < 1.9 and length(A[:common]) > 120 and 25 < ahead and (best is None or ahead < best[4]):
                best = (A[k][2], B, common, k, ahead, s)
        s += 8
    assert best, "no usable obstacle on route A"
    obst_eid, B, common, k_obst, obst_ahead, obst_s = best

    def offset_for(eid):
        e = edges[eid]
        if e["kind"] != "shared_road":
            return 0.0
        hwy = ways.get(eid[1:].split("-")[0], {}).get("highway", "residential")
        return ROAD_WIDTH.get(hwy, 6) / 2 + 1.6

    def polyline(steps):
        """Points along the steps, kept on the pavement.

        A street without a mapped pavement is walked beside its centre line, on the side
        the walker is already on, so the walker never zig-zags across it. A short street
        piece (under 15 m) between two pavements is a crossing and keeps the centre line.
        Spikes, where the line goes out and straight back, are removed at the end.
        """
        out = []
        for u, v, eid in steps:
            e = edges[eid]
            geo = e["geometry"] if e["from"] == u else list(reversed(e["geometry"]))
            pts = [to_xz(lat, lng) for lng, lat in geo]
            off = offset_for(eid)
            if e["kind"] == "shared_road" and e["lengthM"] < 15:
                off = 0.0

            def shifted(sign):
                res = []
                for i, (x, z) in enumerate(pts):
                    a = pts[max(0, i - 1)]
                    b = pts[min(len(pts) - 1, i + 1)]
                    dx, dz = b[0] - a[0], b[1] - a[1]
                    L = math.hypot(dx, dz) or 1
                    # Right of the walking direction in an x-east, z-south frame is (-dz, dx).
                    res.append([round(x - dz / L * off * sign, 2), round(z + dx / L * off * sign, 2)])
                return res

            seg_pts = shifted(1)
            if off and out:
                left = shifted(-1)
                if math.dist(left[0], out[-1]) < math.dist(seg_pts[0], out[-1]):
                    seg_pts = left
            for p in seg_pts:
                if not out or math.hypot(p[0] - out[-1][0], p[1] - out[-1][1]) > 0.3:
                    out.append(p)

        def despike(line):
            changed = True
            while changed and len(line) > 2:
                changed = False
                for i in range(1, len(line) - 1):
                    a, b, c = line[i - 1], line[i], line[i + 1]
                    v1 = (b[0] - a[0], b[1] - a[1])
                    v2 = (c[0] - b[0], c[1] - b[1])
                    n1, n2 = math.hypot(*v1), math.hypot(*v2)
                    if n1 == 0 or n2 == 0:
                        del line[i]; changed = True; break
                    if (v1[0] * v2[0] + v1[1] * v2[1]) / (n1 * n2) < -0.3:
                        del line[i]; changed = True; break
            return line

        return despike(out)

    A1, A2, Brest = A[:common], A[common:], B[common:]
    dp = A1[-1][1]

    def heading(step):
        u, v, eid = step
        geo = edges[eid]["geometry"] if edges[eid]["from"] == u else list(reversed(edges[eid]["geometry"]))
        (lng1, lat1), (lng2, lat2) = geo[0], geo[min(1, len(geo) - 1)]
        return ((lng2 - lng1) * COS, lat2 - lat1)

    a, b = heading(A2[0]), heading(Brest[0])
    cross = a[0] * b[1] - a[1] * b[0]
    turn = "αριστερά" if cross > 0 else "δεξιά"

    oe = edges[obst_eid]
    mid = oe["geometry"][len(oe["geometry"]) // 2]
    ox, oz = to_xz(mid[1], mid[0])
    g0, g1 = oe["geometry"][0], oe["geometry"][-1]
    oang = math.atan2((g1[0] - g0[0]) * COS, -(g1[1] - g0[1]))
    ooff = offset_for(obst_eid)
    nxo, nzo = math.cos(oang), -math.sin(oang)

    def names(steps):
        seen = []
        for _, _, eid in steps:
            n = edges[eid].get("name") or ""
            if n and n not in seen:
                seen.append(n)
        return seen

    def main_street(steps):
        """The named street that covers most of the route."""
        by_len = {}
        for _, _, eid in steps:
            n = edges[eid].get("name")
            if n:
                by_len[n] = by_len.get(n, 0) + edges[eid]["lengthM"]
        return max(by_len, key=by_len.get) if by_len else ""

    # The City's four accessible routes for people with visual impairment
    # (accessibleroutes.thisisathens.org, 2021), routed on the graph through the
    # points the guide names. The guide publishes text, not route geometry, so these
    # lines follow its stops, not its exact pavements.
    CITY_ROUTES = [
        ("Ιστορικό Κέντρο", [(37.9755, 23.7357), (37.97635, 23.72865), (37.9761, 23.7256), (37.9768, 23.7203), (37.9787, 23.7110)]),
        ("Ακρόπολη", [(37.9689, 23.7295), (37.9685, 23.7285), (37.9708, 23.7246), (37.9740, 23.7190)]),
        ("Ομόνοια", [(37.9804, 23.7330), (37.9895, 23.7318), (37.9841, 23.7280)]),
        ("Εθνικός Κήπος", [(37.9755, 23.7357), (37.9735, 23.7375), (37.9716, 23.7368), (37.9703, 23.7318), (37.9693, 23.7335), (37.9683, 23.7395), (37.9755, 23.7357)]),
    ]
    node_xy = {nid: to_xz(lat, lng) for nid, (lat, lng) in gn.items()}

    def snap(lat, lng):
        x, z = to_xz(lat, lng)
        return min(node_xy, key=lambda n: (node_xy[n][0] - x) ** 2 + (node_xy[n][1] - z) ** 2)

    city_routes = []
    for name, stops in CITY_ROUTES:
        steps = []
        ids = [snap(*s) for s in stops]
        for a, b in zip(ids, ids[1:]):
            part = dijkstra(a, b)
            if part:
                steps += part
        city_routes.append({"name": name, "pts": polyline(steps), "lengthM": round(length(steps))})

    # Building footprints of the wider centre, flat, for the overview of the four routes.
    BIG = (37.965, 23.700, 37.990, 23.740)
    footprints = []
    for (t_, i_), e_ in els.items():
        if t_ != "way" or "building" not in e_.get("tags", {}):
            continue
        ids_ = e_.get("nodes", [])
        if len(ids_) < 4 or ids_[0] != ids_[-1]:
            continue
        ll = [nodes[n] for n in ids_[:-1] if n in nodes]
        if len(ll) < 3:
            continue
        clat = sum(p[0] for p in ll) / len(ll)
        clng = sum(p[1] for p in ll) / len(ll)
        if not (BIG[0] <= clat <= BIG[2] and BIG[1] <= clng <= BIG[3]) or inside(clat, clng):
            continue
        ring = [to_xz(*p) for p in ll]
        if abs(poly_area(ring)) < 20:
            continue
        footprints.append([round(c, 1) for p in ring for c in p])

    # Streets of the wider centre, as thin lines, for the flat map of the four routes.
    wide_roads = []
    for (t_, i_), e_ in els.items():
        if t_ != "way":
            continue
        hw_ = e_.get("tags", {}).get("highway")
        if hw_ not in ROAD_WIDTH and hw_ not in ("pedestrian", "footway", "steps"):
            continue
        ll = [nodes[n] for n in e_.get("nodes", []) if n in nodes]
        if len(ll) < 2 or not any(BIG[0] <= la <= BIG[2] and BIG[1] <= lo <= BIG[3] for la, lo in ll):
            continue
        cls = "major" if hw_ in ("trunk", "primary", "secondary", "primary_link", "secondary_link") else (
            "minor" if hw_ in ROAD_WIDTH else "path")
        wide_roads.append([cls, [round(c, 1) for p in ll for c in to_xz(*p)]])

    hall_ll = (37.981918, 23.727147)
    scene = {
        "attribution": "© OpenStreetMap contributors (ODbL)",
        "origin": ORIGIN,
        "buildings": buildings,
        "hall": hall,
        "hallCentre": to_xz(*hall_ll),
        "roads": roads,
        "areas": areas,
        "fronts": fronts,
        "trees": trees,
        "kiosks": kiosks,
        "cafes": cafes,
        "crossings": crossings,
        "route": {
            "A1": polyline(A1),
            "A2": polyline(A2),
            "B": polyline(Brest),
            "turn": turn,
            "lengthA": round(total),
            "lengthB": round(length(B)),
            "namesA2": names(A2),
            "namesB": names(Brest),
            # Metres along the A2 polyline where the scaffold stands (middle of the closed edge).
            "obstacleAt": round(obst_ahead, 1),
            # A separate pavement has no name in OSM; it belongs to the street the route is on.
            "obstacleStreet": oe.get("name") or main_street(A),
            "decision": to_xz(*gn[dp]),
        },
        "cityRoutes": city_routes,
        "footprints": footprints,
        "wideRoads": wide_roads,
        "landmarks": {
            "acropolis": to_xz(37.97155, 23.72575),
            "lycabettus": to_xz(37.98184, 23.74300),
        },
    }
    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write("// Generated by presentation/tools/build-scene.py. Data © OpenStreetMap contributors, ODbL 1.0.\n")
        fh.write("window.ATHENS_SCENE = ")
        json.dump(scene, fh, ensure_ascii=False, separators=(",", ":"))
        fh.write(";\n")
    r = scene["route"]
    print(
        f"buildings {len(buildings)}, roads {len(roads)}, areas {len(areas)}, fronts {len(fronts)}, "
        f"trees {len(trees)}, kiosks {len(kiosks)}, cafes {len(cafes)}, crossings {len(crossings)}"
    )
    print(f"route A {r['lengthA']} m, B {r['lengthB']} m, turn {turn}, A2 via {r['namesA2']}, B via {r['namesB']}")
    print("city routes:", [(c["name"], c["lengthM"], len(c["pts"])) for c in city_routes], "footprints", len(footprints))
    print(f"A1 {len(r['A1'])} pts, scaffold {r['obstacleAt']} m into A2 on {r['obstacleStreet']}, size {os.path.getsize(OUT)//1024} KB")


if __name__ == "__main__":
    main()

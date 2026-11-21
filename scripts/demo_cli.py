#!/usr/bin/env python3
"""Local Linux rehearsal launcher. No dependencies beyond the project and python3."""

import argparse
import base64
import contextlib
import fcntl
import ipaddress
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parent.parent
RUN = ROOT / "data-local/run"
HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def request(url, body=None, html=False):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}
    )
    with HTTP.open(req, timeout=20) as response:
        return response.read().decode() if html else json.load(response)


def command(*args):
    try:
        return subprocess.check_output(
            args, text=True, stderr=subprocess.DEVNULL, timeout=8
        ).strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def bound(port):
    for host in ("127.0.0.1", "::1"):
        try:
            with socket.create_connection((host, port), timeout=0.3):
                return True
        except OSError:
            continue
    return False


def signature(pid):
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        if fields[0] != "Z":
            return [
                Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
                fields[19],
            ]
    except (OSError, IndexError):
        pass
    return None


def atomic(file, value):
    tmp = file.with_suffix(".tmp")
    tmp.write_text(json.dumps(value))
    tmp.replace(file)


def devices():
    rows = command("adb", "devices").splitlines()[1:]
    return [
        r.split()[0] for r in rows if len(r.split()) >= 2 and r.split()[1] == "device"
    ]


def forwards(serial):
    return dict(
        r.split()[-2:]
        for r in command("adb", "-s", serial, "reverse", "--list").splitlines()
        if len(r.split()) >= 2
    )


def local_networks():
    rows = json.loads(command("ip", "-j", "-4", "addr") or "[]")
    return [
        ipaddress.ip_interface(f"{a['local']}/{a['prefixlen']}")
        for row in rows
        for a in row.get("addr_info", [])
        if a.get("scope") == "global"
    ]


class Demo:
    def __init__(self, opts):
        self.o = opts
        self.dir = RUN / f"{opts.api_port}-{opts.web_port}"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.api = f"http://127.0.0.1:{opts.api_port}/api"
        self.web = f"http://127.0.0.1:{opts.web_port}"
        self.model = f"http://127.0.0.1:{opts.vision_port}"
        self.note_file = self.dir / "stage-note"
        if not self.note_file.exists():
            atomic(self.note_file, "ION rehearsal " + uuid.uuid4().hex)
        self.note = json.loads(self.note_file.read_text())

    def owned(self, name):
        record = self.dir / (name + ".pid")
        if record.exists():
            p = json.loads(record.read_text())
            if signature(p["pid"]) == p["start"] and p["start"]:
                return p["pid"]
        return None

    def start(self, name, port, cmd, ready, env=None, cwd=ROOT):
        if bound(port):
            try:
                ready()
            except (OSError, ValueError, KeyError, RuntimeError) as error:
                raise RuntimeError(
                    f"{name} port {port} already in use but not ready on IPv4: {error}"
                ) from error
            print(
                f"{name} {port} · "
                + ("managed" if self.owned(name) else "already running, external")
            )
            return
        with (self.dir / (name + ".log")).open("ab") as log:
            process = subprocess.Popen(
                cmd,
                cwd=cwd,
                env={**os.environ, **(env or {})},
                stdin=subprocess.DEVNULL,
                stdout=log,
                stderr=log,
                start_new_session=True,
            )
        atomic(
            self.dir / (name + ".pid"),
            {"pid": process.pid, "start": signature(process.pid)},
        )
        for _ in range(90):
            if process.poll() is not None:
                break
            try:
                ready()
                print(f"{name} {port} · started PID {process.pid}")
                return
            except (ValueError, OSError, RuntimeError):
                time.sleep(0.25)
        self.stop(name)
        raise RuntimeError(f"{name} could not start; see {self.dir}/{name}.log")

    def stop(self, name):
        pid = self.owned(name)
        if pid:
            # A pidfd also guards the interval between the identity check and signal.
            with contextlib.ExitStack() as stack:
                fd = os.pidfd_open(pid)
                stack.callback(os.close, fd)
                if self.owned(name) == pid:
                    signal.pidfd_send_signal(fd, signal.SIGTERM)
                    for _ in range(100):
                        if not self.owned(name):
                            break
                        time.sleep(0.05)
                    else:
                        raise RuntimeError(f"{name} PID {pid} did not stop")
                    print(f"{name} · stopped PID {pid}")
        (self.dir / (name + ".pid")).unlink(missing_ok=True)

    def start_api(self):
        def ready():
            if not request(self.api + "/health").get("graph"):
                raise RuntimeError("unexpected API")
            if (
                request(self.api + "/demo/rewind-reports").get("scope")
                != "local-rehearsal-reports"
            ):
                raise RuntimeError("API lacks current demo controls")

        self.start(
            "api",
            self.o.api_port,
            [
                "node",
                "--env-file-if-exists=.env",
                "--import",
                "tsx",
                "apps/server/src/index.ts",
            ],
            ready,
            {
                "PORT": str(self.o.api_port),
                "VISION_URL": self.model,
                "VISION_MODEL": os.environ.get("VISION_MODEL", "qwen3-vl:4b-instruct"),
                "ION_DEMO_RECEIPTS": str(self.dir / "reports"),
                "ION_DEMO_STAGE_NOTE": self.note,
            },
        )

    def up(self):
        for port in (8787, 5173, 5175, 5443, 11435):
            if bound(port):
                print(f"Listener · {port} in use")
        try:
            self.start(
                "vision",
                self.o.vision_port,
                [ROOT / "scripts/vision-start", "--foreground"],
                lambda: request(self.model + "/api/version")["version"],
                {"VISION_HOST": f"127.0.0.1:{self.o.vision_port}"},
            )
        except (OSError, RuntimeError, KeyError) as e:
            print("OPTIONAL · vision:", e)
        self.start_api()

        def ready():
            if "/src/main.tsx" not in request(self.web + "/play", html=True):
                raise RuntimeError("port does not serve the game")
            proxy = request(self.web + "/api/health")
            direct = request(self.api + "/health")
            if not proxy.get("ok") or proxy.get("sandbox", {}).get(
                "checkedAt"
            ) != direct.get("sandbox", {}).get("checkedAt"):
                raise RuntimeError("proxy points to another API")
            listeners = command("ss", "-H", "-ltn", "sport", "=", str(self.o.web_port))
            if listeners and not any(
                f"{host}:{self.o.web_port}" in listeners
                for host in ("0.0.0.0", "*", "[::]")
            ):
                raise RuntimeError(
                    "web server listens on loopback only; use an available --web-port"
                )

        self.start(
            "web",
            self.o.web_port,
            [
                "node",
                ROOT / "node_modules/vite/bin/vite.js",
                "--host",
                "0.0.0.0",
                "--port",
                str(self.o.web_port),
                "--strictPort",
            ],
            ready,
            {"ION_API_PORT": str(self.o.api_port)},
            ROOT / "apps/web",
        )
        self.usb()
        query = urllib.parse.urlencode(
            {"room": self.o.preset, "loop": self.o.preset, "citizen": "live", "text": self.note}
        )
        print(
            f"1. Laptop  {self.web}/stage?{query}\n2. USB Android  http://localhost:{self.o.device_port}/play?loop={self.o.preset}"
        )

    def usb(self):
        attached = devices()
        if not attached:
            print("OPTIONAL · no authorised Android")
        for serial in attached:
            src, dst = f"tcp:{self.o.device_port}", f"tcp:{self.o.web_port}"
            current = forwards(serial).get(src)
            if current == dst:
                print(f"USB · existing {src} → {dst}")
            else:
                flags = [] if current else ["--no-rebind"]
                subprocess.run(
                    ["adb", "-s", serial, "reverse", *flags, src, dst],
                    check=True,
                    stdout=subprocess.DEVNULL,
                )
                record = self.dir / "usb.json"
                mappings = json.loads(record.read_text()) if record.exists() else []
                atomic(record, mappings + [[serial, src, dst, current]])
                print(
                    f"USB · {src} → {dst}"
                    + (f" (previous {current})" if current else "")
                )

    def down(self):
        for name in ("web", "api", "vision"):
            self.stop(name)
        record = self.dir / "usb.json"
        if record.exists():
            pending = []
            for row in reversed(json.loads(record.read_text())):
                serial, src, dst, *prior = row
                previous = prior[0] if prior else None
                if serial not in devices():
                    pending.insert(0, row)
                elif forwards(serial).get(src) == dst:
                    args = [src, previous] if previous else ["--remove", src]
                    subprocess.run(["adb", "-s", serial, "reverse", *args], check=True)
            if pending:
                atomic(record, pending)
            else:
                record.unlink()
        print("Managed services stopped.")

    def resolve(self):
        ledger = request(self.api + "/demo/rewind-reports")
        if ledger.get("scope") != "local-rehearsal-reports":
            raise RuntimeError("API does not provide rehearsal receipts")
        for id_ in ledger["ids"]:
            request(self.api + "/demo/resolve/" + urllib.parse.quote(id_, safe=""), {})
            print("Resolved rehearsal receipt", id_)

    def rewind(self):
        if not self.owned("api"):
            raise RuntimeError(
                "API is external. Rewind requires an API started by demo-up on these ports."
            )
        start = time.monotonic()
        self.resolve()
        self.stop("api")
        self.start_api()
        loop = request(self.api + "/demo/loop?preset=" + self.o.preset)
        lng, lat = loop["obstacle"]["position"]
        seeded = request(self.api + "/reports?rehearsal=1", {"lng":lng,"lat":lat,"category":"sidewalk","text":"Επίδειξη ION · πρώτη αναφορά εμποδίου"})
        print("First rehearsal report", seeded["report"]["id"])
        result = self.check()
        print(f"Rewind including preflight · {time.monotonic() - start:.1f} s")
        return result

    def check(self):
        return preflight(self)


def verdicts(health, loop, missions, facts, rewards):
    sandbox = health.get("sandbox", {})
    quota = sandbox.get("llmMessagesLeftToday")
    graph = health.get("graph", {})
    survey = health.get("routing", {}).get("enrichment", {})
    ids = [loop.get("crossing", {}).get("id"), loop.get("venueMissionId")]
    votes = [missions.get(id_) for id_ in ids]
    geometry = loop.get("obstacle", {})
    ahead = geometry.get("distanceToDecisionM", 0)
    progress = loop.get("walkerProgressM", -1)
    theatre = [r for r in rewards.get("rewards", []) if "standardPointsRequired" in r]
    return [
        (
            "Sandbox",
            sandbox.get("reachable") and isinstance(quota, int) and quota > 0,
            f"assistant quota {quota}",
        ),
        (
            "Graph",
            graph.get("loaded")
            and (graph.get("nodes"), graph.get("edges")) == (7101, 10360),
            f"{graph.get('nodes')} nodes, {graph.get('edges')} edges",
        ),
        (
            "Survey",
            isinstance(survey.get("loaded"), bool),
            f"{survey.get('records', 0)} enriched edges"
            if survey.get("loaded")
            else "absent; OSM only",
        ),
        (
            "Loop",
            loop.get("demo")
            and ahead > 0
            and 0 <= progress < progress + ahead <= loop.get("lengthM", 0),
            f"walker {progress:.0f} m, decision {ahead:.0f} m ahead",
        ),
        (
            "Missions",
            loop.get("crossing", {}).get("open")
            and loop.get("venueMissionOpen")
            and all(v and v.get("yes") == 0 and v.get("no") == 0 for v in votes),
            f"crossing / venue votes {votes}",
        ),
        (
            loop.get("destination",{}).get("name","Olympia"),
            bool(facts)
            and all(
                (f.get("source") == "unknown" and f.get("value") is None) or (loop.get("preset") == "acropolis" and f.get("source") == "openstreetmap") for f in facts
            ),
            f"{sum(f.get('value') is not None for f in facts)}/{len(facts)} known",
        ),
        (
            "Rewards",
            rewards.get("demo")
            and bool(theatre)
            and all(
                r["pointsRequired"] == min(60, r["standardPointsRequired"])
                for r in theatre
            ),
            ", ".join(
                f"{r['partner']} {r['pointsRequired']}/{r['standardPointsRequired']}"
                for r in theatre
            )
            or "no theatre threshold",
        ),
    ]


def preflight(demo):
    failures = []

    def line(name, ok, detail, optional=False):
        status = "OK" if ok else ("INFO" if optional else "FAIL")
        print(f"{status} · {name} · {detail}", flush=True)
        if not ok and not optional:
            failures.append(name)

    def get(path):
        try:
            return request(demo.api + path)
        except (OSError, ValueError) as error:
            print(f"INFO · {path} · {error}")
            return {}

    h = get("/health")
    line("API", h.get("ok"), demo.api)
    loop = get("/demo/loop?preset="+demo.o.preset)
    dest = loop.get("destination", {})
    missions = {}
    for pos in [
        loop.get("crossing", {}).get("position"),
        [dest.get("lng"), dest.get("lat")],
    ]:
        if pos and None not in pos:
            data = get(f"/missions?lng={pos[0]}&lat={pos[1]}&radius=100&limit=100")
            missions.update({m["id"]: m["answers"] for m in data.get("missions", [])})
    hall = get("/venues/community_centre-x-w217627849")
    open_hall = get(f"/missions?lng={hall.get('lng')}&lat={hall.get('lat')}&radius=120&limit=100")
    hall_questions = [m for m in open_hall.get("missions", []) if m.get("venueId") == hall.get("id")]
    unknown = sum(f.get("value") is None for f in hall.get("facts", []))
    line("Serafeio", unknown > 0 and bool(hall_questions), f"{unknown} unknown fields, {len(hall_questions)} open questions")
    lift = get("/demo/loop?preset=acropolis").get("lift", {})
    line("Akropoli lifts", bool(lift.get("fetchedAt")), str(lift))
    route_edges = set()
    if loop.get("start") and dest:
        try:
            route = request(
                demo.api + "/route",
                {
                    "from": loop["start"],
                    "to": dest,
                    "venueId": dest["id"],
                    "profile": "voice",
                },
            )
            route_edges.update(route.get("route", {}).get("edges", []))
        except (OSError, ValueError) as e:
            print("INFO · route ·", e)
    expected = loop.get("obstacle", {}).get("edgeId")
    line(
        "Walking route",
        expected in route_edges,
        f"{len(route_edges)} segments; expected obstacle edge {expected}",
    )
    facts = get("/venues/"+dest.get("id","theatre-x-w780950690")).get("facts", [])
    rewards = get("/rewards?demo=true&participant=ion-preflight")
    for row in verdicts(h, loop, missions, facts, rewards):
        line(*row)
    ledger = get("/demo/rewind-reports")
    snapshot = get("/obstacles")
    edge = loop.get("obstacle", {}).get("edgeId")
    nearby = {
        o["source"]["ref"]
        for o in snapshot.get("obstacles", [])
        if o.get("edgeId") in (route_edges | {edge})
        and o.get("source", {}).get("kind") == "sandbox_request"
    }
    ours = ledger.get("ids", [])
    line(
        "Reports",
        ledger.get("scope") == "local-rehearsal-reports"
        and snapshot.get("stale") is False
        and not (nearby - set(ours)),
        f"owned {ours}; other on route {sorted(nearby - set(ours))}; --resolve closes only recorded receipts"
        + ("; API lacks receipt support" if not ledger else ""),
    )
    seed = [o for o in snapshot.get("obstacles", []) if o.get("edgeId") == edge and o.get("blocks") == "partial" and o.get("source",{}).get("ref") in ours]
    line("First rehearsal report", bool(seed), "pending confirmation; run demo-rewind before the live act")
    try:
        seen = request(demo.web + "/api/health")
        direct = request(demo.api + "/health")
        matches = (
            seen.get("ok")
            and seen.get("sandbox", {}).get("checkedAt")
            == direct["sandbox"]["checkedAt"]
        )
        line("IPv4 web/API proxy", matches, demo.web)
    except (OSError, ValueError, KeyError) as error:
        line("IPv4 web/API proxy", False, str(error))
    pages = subprocess.run(
        ["node", ROOT / "scripts/browser/preflight.cjs", demo.web, demo.o.preset],
        cwd=ROOT,
        check=False,
    )
    line("Web routes", pages.returncode == 0, "/stage, /play, /play/scan, /about")
    vision = get("/vision/status")
    try:
        photo = next((ROOT / "data-local/vision/testset/set").glob("t02_768.jpg"), None)
        if not vision.get("answering"):
            line("Vision", False, "model unavailable", True)
        elif photo:
            body = {
                "image": base64.b64encode(photo.read_bytes()).decode(),
                "lng": 23.73,
                "lat": 37.98,
                "participant": "ion-preflight",
                "purpose": "map",
            }
            if not vision.get("samples"):
                request(demo.api + "/vision/observe", body)
            start = time.monotonic()
            frame = request(demo.api + "/vision/observe", body)
            line(
                "Vision",
                isinstance(frame.get("proposals"), list),
                f"{vision.get('model')} · frame {time.monotonic() - start:.1f} s; model {frame.get('ms')} ms",
                True,
            )
        else:
            line("Vision", True, "responding; no local test photograph", True)
    except (OSError, ValueError) as error:
        line("Vision", False, str(error), True)
    nets = local_networks()
    line("Laptop network", bool(nets), ", ".join(map(str, nets)) or "unknown", True)
    attached = devices()
    if not attached:
        line("USB", False, "no authorised device", True)
    for serial in attached:
        mapping = forwards(serial).get(f"tcp:{demo.o.device_port}")
        line(
            "USB",
            mapping == f"tcp:{demo.o.web_port}",
            f"phone {demo.o.device_port} → {mapping or 'unmapped'}",
            True,
        )
        addr = command(
            "adb", "-s", serial, "shell", "ip", "-4", "-o", "addr", "show", "wlan0"
        ).split()
        phone = (
            ipaddress.ip_interface(addr[addr.index("inet") + 1])
            if "inet" in addr
            else None
        )
        same = phone and any(
            phone.ip in n.network and n.ip in phone.network for n in nets
        )
        line(
            "Phone Wi-Fi",
            bool(same),
            "shared IPv4 subnet"
            if same
            else ("different subnet" if phone and nets else "unknown"),
            True,
        )
    line("Greek voice", False, "verify el-GR playback in the phone browser", True)
    line(
        "Disk", True, f"{shutil.disk_usage(ROOT).free / 2**30:.1f} GiB available", True
    )
    power = [
        f.read_text().strip()
        for f in Path("/sys/class/power_supply").glob("*/status")
        if (f.parent / "type").read_text().strip() == "Battery"
    ]
    mains = [
        f.read_text().strip()
        for f in Path("/sys/class/power_supply").glob("*/online")
        if (f.parent / "type").read_text().strip() == "Mains"
    ]
    line(
        "Power",
        bool(power),
        ("on AC" if "1" in mains else "on battery" if mains else "AC unknown")
        + "; "
        + (", ".join(power) or "unknown"),
        True,
    )
    return int(bool(failures))


def port(value):
    n = int(value)
    if not 1 <= n <= 65535:
        raise argparse.ArgumentTypeError("port must be 1..65535")
    return n


def main():
    name = Path(sys.argv[0]).name
    parser = argparse.ArgumentParser(prog=name)
    for key, default in [
        ("api", 8787),
        ("web", 5173),
        ("device", 5173),
        ("vision", 11435),
    ]:
        parser.add_argument("--" + key + "-port", type=port, default=default)
    parser.add_argument("--preset",choices=["olympia","acropolis"],default="acropolis")
    if name == "demo-check":
        parser.add_argument("--resolve", action="store_true")
    o = parser.parse_args()
    RUN.mkdir(parents=True, exist_ok=True)
    with (RUN / "operations.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        demo = Demo(o)
        if getattr(o, "resolve", False):
            demo.resolve()
        return getattr(demo, name.removeprefix("demo-"))() or 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (
        OSError,
        ValueError,
        KeyError,
        RuntimeError,
        subprocess.SubprocessError,
    ) as exc:
        sys.exit(f"FAIL · {exc}")

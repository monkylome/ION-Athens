import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { participantId } from "../play/api";
import { parseFake } from "../play/sensors";
import { cancelSpeech, speak } from "../voice/speech";
import { type VisionStatus, VisionError, vision } from "./api";
import { captureFrame } from "./frame";
import { Glyph } from "./glyph";
import {
  CONFIDENCE_WORD, STOP_TEXT, WALK_INTERVAL_MS, type ConfirmResult, type Proposal,
  confirmText, counterText, movedEnough, notice, walkStop,
} from "./logic";
import "./scan.css";

type Mode = "map" | "describe";
type Fix = { lng: number; lat: number; heading?: number };
interface Tile {
  id: number;
  proposal: Proposal;
  position: Fix;
  state: "open" | "sending" | "done" | "error";
  text?: string;
}

/** Position for testing without a GPS: /play/scan?lng=23.7275&lat=37.9755 */
function fixedPosition(): Fix | null {
  const q = new URLSearchParams(location.search);
  const fake = parseFake(q.get("fake"));
  if (fake) return { lng: fake[0], lat: fake[1] };
  const lng = Number(q.get("lng")), lat = Number(q.get("lat"));
  return q.has("lng") && q.has("lat") && Number.isFinite(lng) && Number.isFinite(lat) ? { lng, lat } : null;
}

const cameraProblem = (error: unknown): string => {
  const name = error instanceof DOMException ? error.name : "";
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) return "Η κάμερα χρειάζεται ασφαλή σύνδεση. Ανοίξτε τη σελίδα με διεύθυνση που αρχίζει από https://.";
  if (name === "NotAllowedError" || name === "SecurityError") return "Δεν επιτράπηκε η κάμερα. Πατήστε το εικονίδιο δίπλα στη διεύθυνση, επιτρέψτε την κάμερα και πατήστε «Δοκιμάστε ξανά».";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "Δεν βρέθηκε κάμερα σε αυτή τη συσκευή.";
  return "Δεν μπόρεσα να ανοίξω την κάμερα. Κλείστε άλλες εφαρμογές που τη χρησιμοποιούν και πατήστε «Δοκιμάστε ξανά».";
};

/** The camera as a map-maker: a model proposes what is in the picture, you confirm with one tap. */
export function Scan() {
  const initial = new URLSearchParams(location.search).get("mode") === "describe" ? "describe" : "map";
  const [mode, setMode] = useState<Mode>(initial);
  const [status, setStatus] = useState<VisionStatus | "loading" | "error">("loading");
  const [camera, setCamera] = useState<"starting" | "ready" | "problem">("starting");
  const [cameraText, setCameraText] = useState("");
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [proposed, setProposed] = useState(0);
  const [confirmed, setConfirmed] = useState(0);
  const [busy, setBusy] = useState(false);
  const [walk, setWalk] = useState(false);
  const [donate, setDonate] = useState(false);
  const [live, setLive] = useState({ n: 0, text: "" });
  const [spoken, setSpoken] = useState("");
  const [hasFix, setHasFix] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const fix = useRef<Fix | null>(fixedPosition());
  const participant = useRef(participantId());
  const tileId = useRef(0);
  const lastSent = useRef<{ at: number; fix: Fix | null }>({ at: 0, fix: null });
  const latency = useRef<number | null>(null);
  const [receipt, setReceipt] = useState<{at: number[]; before: number; text: string; confirmed: boolean} | null>(null);
  const request = useRef<AbortController | null>(null);
  const params = new URLSearchParams(location.search);
  const back = "/play?" + params;
  const busyRef = useRef(false);
  const recent = useRef(new Map<string, number>());
  const donateRef = useRef(donate);
  donateRef.current = donate;

  const say = useCallback((text: string) => setLive((l) => ({ n: l.n + 1, text })), []);

  // What the server can do.
  useEffect(() => {
    let current = true;
    vision.status().then((s) => current && setStatus(s), () => current && setStatus("error"));
    return () => { current = false; };
  }, []);

  // The rear camera.
  const startCamera = useCallback(async () => {
    setCamera("starting");
    setCameraText("");
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new DOMException("no media", "SecurityError");
      stream.current?.getTracks().forEach((t) => t.stop());
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } }, audio: false });
      if (!video.current) { s.getTracks().forEach(track => track.stop()); return; }
      stream.current = s;
      if (video.current) {
        video.current.srcObject = s;
        await video.current.play().catch(() => undefined);
      }
      setCamera("ready");
    } catch (error) {
      setCamera("problem");
      setCameraText(cameraProblem(error));
    }
  }, []);
  useEffect(() => {
    void startCamera();
    return () => {
      stream.current?.getTracks().forEach((t) => t.stop());
      stream.current = null;
      request.current?.abort();
      cancelSpeech();
    };
  }, [startCamera]);

  // Position and compass heading, kept in a ref: a frame is sent with the latest of both.
  useEffect(() => {
    let watch: number | undefined;
    if (!fixedPosition() && navigator.geolocation) {
      watch = navigator.geolocation.watchPosition(
        (p) => {
          fix.current = { lng: p.coords.longitude, lat: p.coords.latitude, ...(fix.current?.heading !== undefined ? { heading: fix.current.heading } : {}) };
          setHasFix(true);
        },
        () => setHasFix(fix.current !== null),
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
      );
    }
    setHasFix(fix.current !== null);
    const onOrientation = (e: DeviceOrientationEvent & { webkitCompassHeading?: number }) => {
      const heading = typeof e.webkitCompassHeading === "number" ? e.webkitCompassHeading : e.absolute && typeof e.alpha === "number" ? (360 - e.alpha) % 360 : undefined;
      if (heading !== undefined && fix.current) fix.current = { ...fix.current, heading };
    };
    window.addEventListener("deviceorientationabsolute", onOrientation as EventListener);
    window.addEventListener("deviceorientation", onOrientation as EventListener);
    return () => {
      if (watch !== undefined) navigator.geolocation.clearWatch(watch);
      window.removeEventListener("deviceorientationabsolute", onOrientation as EventListener);
      window.removeEventListener("deviceorientation", onOrientation as EventListener);
    };
  }, []);

  /** One frame, one question to the model. Returns false when nothing was sent. */
  const scan = useCallback(async (purpose: Mode, automatic = false): Promise<boolean> => {
    const position = fix.current;
    if (busyRef.current || !video.current || !position) return false;
    busyRef.current = true;
    setBusy(true);
    const controller = new AbortController();
    request.current = controller;
    const timeout = window.setTimeout(() => controller.abort("timeout"), 18000);
    video.current.pause();
    const started = performance.now();
    if (!automatic) say(purpose === "describe" ? "Αναλύω την εικόνα." : "Αναλύω την εικόνα. Περιμένετε λίγα δευτερόλεπτα.");
    try {
      const image = await captureFrame(video.current);
      lastSent.current = { at: Date.now(), fix: position };
      const result = await vision.observe({
        image, lng: position.lng, lat: position.lat, ...(position.heading !== undefined ? { heading: Math.round(position.heading) } : {}),
        participant: participant.current, purpose, ...(donateRef.current ? { keep: true } : {}),
      }, controller.signal);
      latency.current = performance.now() - started;
      if (result.queued) { say(result.message ?? "Η φωτογραφία κρατήθηκε και θα αναλυθεί αργότερα."); return true; }
      if (purpose === "describe") {
        const speech = result.speech ?? "";
        setSpoken(speech);
        say("Εκτίμηση του μοντέλου. " + speech);
        speak("Εκτίμηση του μοντέλου. " + speech, { priority: 1 });
        return true;
      }
      const now = Date.now();
      const fresh = (result.proposals ?? []).filter((p) => {
        const key = `${p.kind}:${p.text ?? ""}`;
        const seen = recent.current.get(key);
        recent.current.set(key, now);
        return !(automatic && seen !== undefined && now - seen < 60_000);
      });
      setTiles(fresh.map((proposal) => ({ id: ++tileId.current, proposal, position, state: "open" as const })));
      setProposed((n) => n + fresh.length);
      say(fresh.length ? `Το μοντέλο πρότεινε ${fresh.length}. Πατήστε «Σωστό» ή «Λάθος» σε καθένα.` : automatic ? "" : "Δεν είδα κάτι που να μπορώ να προτείνω. Δοκιμάστε από άλλη γωνία.");
      return true;
    } catch (error) {
      latency.current = performance.now() - started;
      if (controller.signal.aborted) {
        if (controller.signal.reason === "timeout") say("Το μοντέλο άργησε. Δοκιμάστε ξανά ή επιστρέψτε στον χάρτη.");
      } else if (!automatic || !(error instanceof VisionError && error.code === "busy")) say(error instanceof VisionError ? error.message : "Δεν μπόρεσα να πάρω φωτογραφία. Δοκιμάστε ξανά.");
      return false;
    } finally {
      window.clearTimeout(timeout);
      request.current = null;
      void video.current?.play().catch(() => undefined);
      busyRef.current = false;
      setBusy(false);
    }
  }, [say]);

  // Scanning while walking: a frame every few seconds after the person moved, for two minutes at most.
  useEffect(() => {
    if (!walk) return;
    const startedAt = Date.now();
    latency.current = null;
    const stop = (reason: keyof typeof STOP_TEXT) => { setWalk(false); say(STOP_TEXT[reason]); };
    const onHidden = () => { if (document.hidden) stop("hidden"); };
    document.addEventListener("visibilitychange", onHidden);
    const timer = window.setInterval(() => {
      const reason = walkStop({ startedAt, now: Date.now(), hidden: document.hidden, lastLatencyMs: latency.current });
      if (reason) return stop(reason);
      const position = fix.current;
      if (!position || busyRef.current || Date.now() - lastSent.current.at < WALK_INTERVAL_MS) return;
      if (!movedEnough(lastSent.current.fix, position)) return;
      void scan("map", true);
    }, 1000);
    say("Η σάρωση καθώς περπατάτε ξεκίνησε. Σταματά μόνη της μετά από δύο λεπτά.");
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", onHidden); };
  }, [walk, scan, say]);

  const patch = (id: number, change: Partial<Tile>) => setTiles((list) => list.map((t) => (t.id === id ? { ...t, ...change } : t)));

  const right = async (tile: Tile) => {
    const position = tile.position;
    patch(tile.id, { state: "sending" });
    try {
      const result: ConfirmResult = await vision.confirm(participant.current, tile.proposal, position);
      const text = confirmText(result);
      setReceipt(previous => ({at: [position.lng, position.lat], before: previous?.before ?? result.profile.points - result.pointsEarned,
        text: tile.proposal.label + " · " + text, confirmed: !result.needsSecond}));
      patch(tile.id, { state: "done", text });
      setConfirmed((n) => n + 1);
      say(`${tile.proposal.label}. ${text}`);
    } catch (error) {
      const text = error instanceof VisionError ? error.message : "Δεν καταγράφηκε. Δοκιμάστε ξανά.";
      patch(tile.id, { state: "error", text });
      say(text);
    }
  };
  const wrong = (tile: Tile) => {
    setTiles(list => list.filter(t => t.id !== tile.id));
    say("");
  };

  const ready = status !== "loading" && status !== "error" && status.configured && status.answering;
  const canScan = ready && camera === "ready" && hasFix && !busy;

  return (
    <main className="scan" data-surface="phone" data-mode={mode}>
      <h1 className="visually-hidden">Σάρωση με την κάμερα</h1>
      <header className="scan__top">
        <Link className="scan__back" to={back} state={{scanReceipt: receipt}}>Πίσω στον χάρτη</Link>
        {fixedPosition() && <span className="scan__tag">{params.get("demo") === "1" ? "ΘΕΣΗ ΚΑΙ ΑΠΑΝΤΗΣΗ ΕΠΙΔΕΙΞΗΣ" : "ΘΕΣΗ ΕΠΙΔΕΙΞΗΣ"}</span>}
        <p className="scan__notice" data-keep={donate}>{notice(donate)}</p>
        <nav className="scan__modes" aria-label="Τρόπος σάρωσης">
          <button type="button" disabled={busy} aria-pressed={mode === "map"} onClick={() => setMode("map")}>Χαρτογράφηση</button>
          <button type="button" disabled={busy} aria-pressed={mode === "describe"} onClick={() => { setMode("describe"); setWalk(false); }}>Για όποιον δεν βλέπει</button>
        </nav>
      </header>

      <div className="scan__view">
        <video ref={video} muted playsInline autoPlay aria-hidden="true" tabIndex={-1} />
        {camera === "starting" && <p className="scan__plate">Ανοίγω την κάμερα.</p>}
        {camera === "problem" && (
          <div className="scan__plate" role="alert">
            <p>{cameraText}</p>
            <button type="button" className="scan__btn" onClick={() => void startCamera()}>Δοκιμάστε ξανά</button>
          </div>
        )}
        {busy && <div className="scan__plate"><p>Το μοντέλο κοιτάζει…</p>
          <button type="button" className="scan__btn" onClick={() => { setWalk(false); request.current?.abort(); say("Η σάρωση ακυρώθηκε."); }}>Ακύρωση</button></div>}
        {!busy && mode === "map" && tiles.length > 0 && (
          <ul className="scan__tiles" aria-label="Προτάσεις του μοντέλου">
            {visibleTiles(tiles).map((t) => <TileView key={t.id} tile={t} onRight={() => void right(t)} onWrong={() => wrong(t)} />)}
          </ul>
        )}
        {mode === "describe" && spoken && <p className="scan__speech" lang="el">Εκτίμηση του μοντέλου · {spoken}</p>}
      </div>

      <section className="scan__controls" aria-label="Χειριστήρια">
        {status === "loading" && <p className="scan__plain">Ελέγχω αν υπάρχει μοντέλο ανάλυσης.</p>}
        {(status === "error" || (status !== "loading" && !ready)) && (
          <div className="scan__plain" role="status">
            <p>{status === "error" ? "Δεν φτάνω στον διακομιστή. Η ανάλυση εικόνας δεν είναι διαθέσιμη." : !status.configured ? "Η ανάλυση εικόνας δεν είναι ενεργή σε αυτόν τον διακομιστή." : "Το μοντέλο ανάλυσης δεν απαντά αυτή τη στιγμή."}</p>
            <Link className="btn btn--primary" to="/missions">Συνεχίστε με τις συνηθισμένες αποστολές</Link>
          </div>
        )}
        {ready && mode === "map" && (
          <>
            <button type="button" className="scan__btn scan__btn--primary" disabled={!canScan} aria-busy={busy} onClick={() => void scan("map")}>{busy ? "Αναλύω…" : "Σαρώστε"}</button>
            <Switch label="Σάρωση καθώς περπατώ" on={walk} onChange={setWalk} disabled={!canScan && !walk} />
          </>
        )}
        {ready && mode === "describe" && (
          <button type="button" className="scan__btn scan__btn--primary scan__btn--huge" disabled={!canScan} aria-busy={busy} onClick={() => void scan("describe")}>{busy ? "Αναλύω…" : "Τι υπάρχει μπροστά μου;"}</button>
        )}
        {ready && <Switch label="Δωρίστε αυτή τη φωτογραφία στον Δήμο για μελλοντική ανάλυση" on={donate} onChange={setDonate} small />}
        {!hasFix && ready && <p className="scan__plain">Χρειάζομαι τη θέση σας. Επιτρέψτε την τοποθεσία στη σελίδα.</p>}
        {mode === "map" && <p className="scan__count" aria-live="off">{counterText(proposed, confirmed)}</p>}
      </section>
      <p key={live.n} className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">{live.text}</p>
      <p className="scan__line" aria-hidden="true">{live.text}</p>
    </main>
  );
}

/** The picture stays visible: one open proposal at a time, and the last answered one as a short line. */
function visibleTiles(tiles: Tile[]): Tile[] {
  const open = tiles.find((t) => t.state === "open" || t.state === "sending");
  const answered = tiles.filter((t) => t.state !== "open" && t.state !== "sending").slice(-1);
  return [...answered, ...(open ? [open] : [])];
}

function Switch({ label, on, onChange, disabled, small }: { label: string; on: boolean; onChange: (v: boolean) => void; disabled?: boolean; small?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} disabled={disabled} className={`scan__switch${small ? " scan__switch--small" : ""}`} onClick={() => onChange(!on)}>
      <span className="scan__switch-box" aria-hidden="true">{on ? "ΝΑΙ" : "ΟΧΙ"}</span>
      <span>{label}</span>
    </button>
  );
}

function TileView({ tile, onRight, onWrong }: { tile: Tile; onRight: () => void; onWrong: () => void }) {
  const { proposal: p } = tile;
  const decided = tile.state !== "open" && tile.state !== "sending";
  return (
    <li className="scan__tile" data-state={tile.state} data-discovery={p.discovery} data-compact={decided}>
      <div className="scan__tile-head">
        <Glyph kind={p.kind} />
        <div>
          {!decided && <p className="scan__found">Πρόταση του μοντέλου</p>}
          <p className="scan__label">{p.label}</p>
          <p className="scan__evidence" hidden={decided}>{CONFIDENCE_WORD[p.confidence]}: {p.evidence}</p>
          {p.mission && !decided && <p className="scan__question">Απαντά στην ερώτηση: {p.mission.question}</p>}
        </div>
      </div>
      {tile.state === "open" || tile.state === "sending" ? (
        <div className="scan__tile-actions">
          <button type="button" className="scan__btn scan__btn--primary" disabled={tile.state === "sending"} onClick={onRight}>{tile.state === "sending" ? "Στέλνω…" : "Σωστό"}</button>
          <button type="button" className="scan__btn" disabled={tile.state === "sending"} onClick={onWrong}>Λάθος</button>
        </div>
      ) : (
        <p className="scan__result" data-state={tile.state}>{tile.state === "done" ? "Σωστό. " : "Δεν καταγράφηκε. "}{tile.text}</p>
      )}
    </li>
  );
}

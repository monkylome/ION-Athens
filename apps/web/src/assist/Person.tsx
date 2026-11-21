import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { assist } from "./api";
import { useAnnouncer } from "./announce";
import { Call, type CallMode, type CallState } from "./call";
import { NO_RECORDING, iceServers } from "./config";
import { personDevice, secureAddress } from "./device";
import { type Problem, getPosition, locationProblem, mediaProblem, unsupportedProblem } from "./problems";
import { joinRoom, type RoomLink } from "./room";
import { keepAwake } from "./wake";
import "./assist.css";

type Phase = "idle" | "asking" | "waiting" | "connecting" | "live" | "ended" | "problem";

interface Held {
  stream?: MediaStream;
  room?: RoomLink;
  call?: Call;
  watch?: number;
  poll?: number;
  release?: () => void;
  requestId?: string;
  lastPos?: { lng: number; lat: number; acc: number };
  lastSent: number;
}

/** The person's side: one big button, then a call with a citizen who looks through the camera. */
export function Person() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [status, say] = useAnnouncer();
  const [problem, setProblem] = useState<Problem | null>(null);
  const [mode, setMode] = useState<CallMode>("video");
  const audio = useRef<HTMLAudioElement>(null);
  const held = useRef<Held>({ lastSent: 0 });
  const device = useRef(personDevice());
  const secure = secureAddress();
  const supported = typeof RTCPeerConnection !== "undefined";

  const release = useCallback(() => {
    const h = held.current;
    clearInterval(h.poll);
    if (h.watch !== undefined) navigator.geolocation.clearWatch(h.watch);
    h.call?.close();
    h.room?.close();
    h.stream?.getTracks().forEach((t) => t.stop());
    h.release?.();
    if (audio.current) audio.current.srcObject = null;
    held.current = { lastSent: 0 };
  }, []);

  const finish = useCallback((message: string) => {
    const id = held.current.requestId;
    release();
    if (id) void assist.end(id, device.current).catch(() => undefined);
    setPhase("ended");
    say(message);
  }, [release, say]);

  // A page that closes while waiting cancels its request.
  useEffect(() => {
    const leave = () => {
      const id = held.current.requestId;
      if (id) navigator.sendBeacon(`/api/assist/requests/${id}/end`, new Blob([JSON.stringify({ device: device.current })], { type: "application/json" }));
    };
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      leave();
      release();
    };
  }, [release]);

  const fail = (p: Problem, message: string) => {
    release();
    setProblem(p);
    setPhase("problem");
    say(message);
  };

  const onState = (state: CallState, m: CallMode) => {
    setMode(m);
    if (state === "connecting") {
      setPhase("connecting");
      say(m === "audio" ? "Δοκιμάζω σύνδεση μόνο με ήχο." : "Συνδέομαι με τον δημότη.");
    } else if (state === "connected") {
      // Tell the server that sound or picture really arrived: only then does the helper earn points for the call.
      const id = held.current.requestId;
      if (id) void assist.connected(id, device.current).catch(() => undefined);
      setPhase("live");
      say(m === "audio" ? "Συνδέθηκε με ήχο μόνο. Σας ακούει, αλλά δεν βλέπει εικόνα." : "Συνδέθηκε. Σας βλέπει και σας ακούει.");
    } else if (state === "lost") {
      say("Η σύνδεση χάθηκε. Προσπαθώ ξανά.");
    } else {
      finish("Δεν κατάφερα να συνδέσω την κλήση, ούτε με ήχο μόνο. Η κλήση τελείωσε.");
    }
  };

  const startCall = () => {
    const h = held.current;
    if (!h.room) return;
    if (h.call) {
      h.call.start();
      return;
    }
    const room = h.room;
    h.call = new Call({
      role: "person", local: h.stream ?? null, iceServers: iceServers(), send: (d) => void room.send(d), onState,
      onRemote: (s) => { if (audio.current) { audio.current.srcObject = s; void audio.current.play().catch(() => undefined); } },
    });
    h.call.start();
    if (h.lastPos) void room.send({ t: "pos", ...h.lastPos });
  };

  const accepted = (roomName: string) => {
    const h = held.current;
    say("Ένας δημότης ανέλαβε. Συνδέομαι.");
    setPhase("connecting");
    void keepAwake().then((r) => { if (held.current === h) h.release = r; else r(); });
    h.room = joinRoom(roomName, device.current, {
      onHello: (members) => { if (members.length > 0) startCall(); },
      onJoined: () => startCall(),
      onMessage: (_from, data) => void held.current.call?.handle(data),
      onClosed: () => finish("Η κλήση τελείωσε."),
      onFailed: (s) => { if (s === "refused") finish("Η κλήση τελείωσε."); },
    });
    // The position goes to the helper only, through the room, and stops with the call.
    h.watch = navigator.geolocation?.watchPosition((p) => {
      h.lastPos = { lng: p.coords.longitude, lat: p.coords.latitude, acc: Math.round(p.coords.accuracy) };
      const now = Date.now();
      if (now - h.lastSent >= 3000) {
        h.lastSent = now;
        void h.room?.send({ t: "pos", ...h.lastPos });
      }
    }, () => undefined, { enableHighAccuracy: true, maximumAge: 5000 });
  };

  async function begin() {
    if (!supported || !navigator.mediaDevices?.getUserMedia) {
      fail(secure ? mediaProblem(null, "person") : unsupportedProblem(), "Δεν μπορώ να ανοίξω την κάμερα από αυτή τη σελίδα.");
      return;
    }
    setProblem(null);
    setPhase("asking");
    say("Ζητώ πρόσβαση στην κάμερα και το μικρόφωνο.");
    const h = held.current;
    try {
      try {
        h.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: true });
      } catch (e) {
        if (!(e instanceof DOMException) || (e.name !== "NotFoundError" && e.name !== "OverconstrainedError")) throw e;
        h.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        say("Δεν βρέθηκε κάμερα. Θα συνεχίσετε μόνο με ήχο.");
      }
    } catch (e) {
      fail(mediaProblem(e, "person"), "Δεν επιτράπηκε η κάμερα ή το μικρόφωνο.");
      return;
    }
    let position: GeolocationPosition;
    try {
      position = await getPosition();
    } catch {
      fail(locationProblem(), "Δεν έχω τη θέση σας.");
      return;
    }
    try {
      const { request, waitS } = await assist.open(device.current, position.coords.longitude, position.coords.latitude);
      h.requestId = request.id;
      h.lastPos = { lng: position.coords.longitude, lat: position.coords.latitude, acc: Math.round(position.coords.accuracy) };
      setPhase("waiting");
      say("Αναζητώ δημότη κοντά σας.");
      const until = Date.now() + waitS * 1000;
      h.poll = window.setInterval(async () => {
        try {
          const { request: r } = await assist.status(request.id, device.current);
          if (held.current !== h) return;
          if (r.status === "accepted" && r.room) {
            clearInterval(h.poll);
            accepted(r.room);
          } else if (r.status === "expired" || (r.status === "ended" && !h.room)) {
            h.requestId = undefined;
            fail({ title: "Δεν βρέθηκε δημότης αυτή τη στιγμή.", steps: ["Κανείς δεν ανταποκρίθηκε μέσα σε 5 λεπτά.", "Δοκιμάστε ξανά σε λίγο."], retry: "Ζητήστε ξανά" },
              "Δεν βρέθηκε δημότης αυτή τη στιγμή. Δοκιμάστε ξανά σε λίγο.");
          } else if (Date.now() > until + 15_000) {
            finish("Η αναζήτηση τελείωσε.");
          }
        } catch { /* a missed poll is retried by the next one */ }
      }, 2000);
    } catch (e) {
      fail({ title: "Δεν μπόρεσα να στείλω το αίτημα.", steps: [e instanceof Error && /[Α-ω]/.test(e.message) ? e.message : "Ελέγξτε τη σύνδεσή σας στο διαδίκτυο.", "Μετά πατήστε «Δοκιμάστε ξανά»."], retry: "Δοκιμάστε ξανά" },
        "Δεν μπόρεσα να στείλω το αίτημα.");
    }
  }

  const busy = phase === "asking" || phase === "waiting" || phase === "connecting" || phase === "live";
  return (
    <main className="page assist" data-surface="phone" data-phase={phase}>
      <h1 className="visually-hidden">Ζωντανή βοήθεια από δημότη</h1>
      {!busy && <Link className="btn btn--quiet page__back" to="/phone">Πίσω</Link>}
      {secure && phase === "idle" && (
        <section aria-labelledby="secure-h">
          <h2 id="secure-h">Χρειάζεται ασφαλής σύνδεση</h2>
          <p>Η κάμερα ανοίγει μόνο σε σελίδα με https://. Ανοίξτε αυτή τη διεύθυνση και αποδεχτείτε το πιστοποιητικό:</p>
          <a className="btn btn--primary" data-on="accent" href={secure}>Άνοιγμα με ασφαλή σύνδεση</a>
        </section>
      )}
      {phase === "idle" && !secure && (
        <button className="btn btn--primary assist__ask" data-on="accent" onClick={() => void begin()}>
          Ζητήστε έναν δημότη να δει για εσάς
        </button>
      )}
      <p className="t-instruction assist__status" role="status" aria-live="polite" aria-atomic="true">{status}</p>
      {phase === "problem" && problem && (
        <section aria-labelledby="problem-h">
          <h2 id="problem-h">{problem.title}</h2>
          <ol>{problem.steps.map((s) => <li key={s}>{s}</li>)}</ol>
          <button className="btn btn--primary" data-on="accent" onClick={() => void begin()}>{problem.retry}</button>
        </section>
      )}
      {phase === "ended" && <button className="btn btn--primary" data-on="accent" onClick={() => { setPhase("idle"); say(""); }}>Νέο αίτημα</button>}
      {busy && (
        <button className="btn assist__end" onClick={() => finish(phase === "waiting" ? "Ακύρωσα την αναζήτηση." : "Η κλήση τελείωσε.")}>
          {phase === "waiting" || phase === "asking" ? "Ακύρωση" : "Τέλος κλήσης"}
        </button>
      )}
      {phase === "live" && mode === "audio" && <p className="t-secondary">Μόνο ήχος.</p>}
      <p className="assist__note">{NO_RECORDING}</p>
      <audio ref={audio} autoPlay />
    </main>
  );
}

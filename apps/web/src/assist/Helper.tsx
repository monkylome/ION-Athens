import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { type MarkResult, type OpenRequest, type Reward, assist } from "./api";
import { useAnnouncer } from "./announce";
import { Call, type CallMode, type CallState } from "./call";
import { MARKS, NO_RECORDING, type MarkKind, iceServers } from "./config";
import { helperDevice, secureAddress } from "./device";
import { type Problem, getPosition, mediaProblem } from "./problems";
import { joinRoom, type RoomLink } from "./room";
import { keepAwake } from "./wake";
import "./assist.css";

type Phase = "list" | "joining" | "live" | "ended" | "problem";
const CENTRE = { lng: 23.7275, lat: 37.9775 };

interface Held {
  stream?: MediaStream;
  room?: RoomLink;
  call?: Call;
  release?: () => void;
  requestId?: string;
}

const meters = (m: number) => (m < 100 ? "Κοντά σας" : m >= 1000 ? `Περίπου ${(m / 1000).toFixed(1).replace(".", ",")} χλμ` : `Περίπου ${m} μέτρα`);

/** The helper's side: open requests, then the other person's camera, and marks for what the helper sees. */
export function Helper() {
  const [phase, setPhase] = useState<Phase>("list");
  const [status, say] = useAnnouncer(false);
  const [requests, setRequests] = useState<OpenRequest[] | null>(null);
  const [where, setWhere] = useState<{ lng: number; lat: number } | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [conn, setConn] = useState<CallState>("connecting");
  const [mode, setMode] = useState<CallMode>("video");
  const [muted, setMuted] = useState(false);
  const [hasVideo, setHasVideo] = useState(false);
  const [personAt, setPersonAt] = useState<{ lng: number; lat: number } | null>(null);
  const [reward, setReward] = useState<Reward | null>(null);
  const [marking, setMarking] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const held = useRef<Held>({});
  const personRef = useRef<typeof personAt>(null);
  const device = useRef(helperDevice());
  const secure = secureAddress();

  const release = useCallback(() => {
    const h = held.current;
    h.call?.close();
    h.room?.close();
    h.stream?.getTracks().forEach((t) => t.stop());
    h.release?.();
    if (video.current) video.current.srcObject = null;
    held.current = {};
  }, []);
  useEffect(() => release, [release]);

  // Where the helper is, to order the list. Without it the list is around the centre of Athens.
  useEffect(() => {
    let alive = true;
    getPosition(8000).then((p) => alive && setWhere({ lng: p.coords.longitude, lat: p.coords.latitude }),
      () => { if (alive) { setWhere(CENTRE); } });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (phase !== "list" || !where) return;
    let alive = true;
    const load = () => assist.nearby(where.lng, where.lat).then((r) => alive && setRequests(r.requests), () => alive && setRequests((old) => old ?? []));
    void load();
    const timer = setInterval(load, 3000);
    return () => { alive = false; clearInterval(timer); };
  }, [phase, where]);

  const finish = useCallback(async (message: string) => {
    const id = held.current.requestId;
    release();
    setPhase("ended");
    say(message);
    if (!id) return;
    try {
      const { request } = await assist.status(id, device.current);
      if (request.reward) {
        setReward(request.reward);
        const r = request.reward;
        say(r.rewarded
          ? `${message} Κερδίσατε ${r.pointsEarned} πόντους. Σύνολο ${r.profile.points} πόντοι, επίπεδο ${r.profile.level}.`
          : r.reason === "too_short" ? `${message} Η κλήση κράτησε λιγότερο από 30 δευτερόλεπτα, γι' αυτό δεν δίνει πόντους.` : `${message} Φτάσατε το όριο πόντων κλήσεων για σήμερα.`);
      }
    } catch { /* the call is over either way */ }
  }, [release, say]);

  async function accept(r: OpenRequest) {
    setPhase("joining");
    setProblem(null);
    setReward(null);
    setPersonAt(null);
    personRef.current = null;
    setMuted(false);
    setHasVideo(false);
    setConn("connecting");
    say("Ζητώ πρόσβαση στο μικρόφωνο.");
    const h: Held = {};
    held.current = h;
    try {
      h.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      const name = e instanceof DOMException ? e.name : "";
      if (name !== "NotFoundError" && name !== "OverconstrainedError") {
        release();
        setProblem(mediaProblem(e, "helper"));
        setPhase("problem");
        say("Δεν επιτράπηκε το μικρόφωνο.");
        return;
      }
      say("Δεν βρέθηκε μικρόφωνο. Θα βλέπετε και θα ακούτε, αλλά ο άνθρωπος δεν θα σας ακούει.");
    }
    try {
      const { request } = await assist.accept(r.id, device.current);
      h.requestId = r.id;
      const roomName = request.room!;
      void keepAwake().then((rel) => { if (held.current === h) h.release = rel; else rel(); });
      h.call = new Call({
        role: "helper", local: h.stream ?? null, iceServers: iceServers(),
        send: (d) => void h.room?.send(d),
        onState: (s, m) => { setConn(s); setMode(m); if (s === "connected") say(m === "audio" ? "Συνδέθηκε με ήχο μόνο." : "Συνδέθηκε."); else if (s === "lost") say("Η σύνδεση χάθηκε. Περιμένω νέα προσπάθεια."); else if (s === "failed") void finish("Η σύνδεση δεν ήταν δυνατή. Η κλήση τελείωσε."); },
        onRemote: (s) => {
          setHasVideo(!!s?.getVideoTracks().length);
          if (video.current) { video.current.srcObject = s; void video.current.play().catch(() => undefined); }
        },
      });
      h.room = joinRoom(roomName, device.current, {
        onMessage: (_from, data) => {
          const m = data as { t?: string; lng?: number; lat?: number };
          if (m?.t === "pos" && typeof m.lng === "number" && typeof m.lat === "number") {
            personRef.current = { lng: m.lng, lat: m.lat };
            setPersonAt(personRef.current);
          } else void h.call?.handle(data);
        },
        onClosed: () => void finish("Η κλήση τελείωσε."),
        onFailed: (s) => { if (s === "refused") void finish("Η κλήση τελείωσε."); },
      });
      setPhase("live");
      say("Αποδεχτήκατε το αίτημα. Περιμένω τη σύνδεση.");
    } catch (e) {
      release();
      const message = e instanceof Error && /[Α-ω]/.test(e.message) ? e.message : "Δεν ήταν δυνατή η αποδοχή του αιτήματος.";
      setPhase("list");
      say(message);
    }
  }

  async function mark(kind: MarkKind, label: string) {
    const at = personRef.current;
    const id = held.current.requestId;
    if (!at || !id || marking) return;
    setMarking(true);
    try {
      const r: MarkResult = await assist.mark(id, device.current, kind, at.lng, at.lat);
      say(`Καταγράφηκε: ${label}. ${r.pointsEarned > 0 ? `${r.pointsEarned} πόντοι.` : "Έχετε φτάσει το ημερήσιο όριο πόντων για σημάνσεις."}${kind === "sidewalk_obstacle" ? (r.report ? " Έγινε και αναφορά στον Δήμο." : " Η αναφορά στον Δήμο δεν έγινε.") : ""} Σύνολο ${r.profile.points} πόντοι.`);
    } catch (e) {
      say(e instanceof Error && /[Α-ω]/.test(e.message) ? e.message : "Η σήμανση δεν καταγράφηκε.");
    } finally { setMarking(false); }
  }

  function toggleMute() {
    const next = !muted;
    setMuted(next);
    held.current.call?.setMuted(next);
  }

  const stateText = conn === "connected" ? (mode === "audio" ? "Συνδέθηκε, μόνο ήχος" : "Συνδέθηκε") : conn === "lost" ? "Η σύνδεση χάθηκε" : conn === "failed" ? "Η σύνδεση απέτυχε" : "Σύνδεση…";

  return (
    <main className="page assist assist--helper" data-surface="phone" data-phase={phase}>
      {phase !== "live" && phase !== "joining" && <Link className="btn btn--quiet page__back" to="/missions">Αποστολές</Link>}
      {phase === "live" && <p className="assist__banner" role="note">Περιγράψτε τι βλέπετε. Την απόφαση την παίρνει ο άνθρωπος που περπατά.</p>}
      {phase === "joining" && <p className="assist__banner" role="note">Περιγράψτε τι βλέπετε. Την απόφαση την παίρνει ο άνθρωπος που περπατά.</p>}

      {phase === "list" && (
        <>
          <h1>Δημότες που ζητούν βοήθεια</h1>
          <p className="assist__lead">Κάποιος δεν βλέπει τον δρόμο μπροστά του. Θα δείτε από την κάμερά του και θα περιγράψετε.</p>
          {secure && <p>Το μικρόφωνο ανοίγει μόνο με https://. <a href={secure}>Ανοίξτε την ασφαλή διεύθυνση</a>.</p>}
          {requests === null && <p>Αναζήτηση αιτημάτων…</p>}
          {requests?.length === 0 && <p>Κανείς δεν ζητά βοήθεια κοντά σας αυτή τη στιγμή. Η λίστα ανανεώνεται μόνη της.</p>}
          {requests?.map((r) => (
            <section key={r.id} aria-label={`Αίτημα, ${r.area}`}>
              <h2>{r.area}</h2>
              <p>{meters(r.distanceM)}. Περιμένει {Math.max(1, Math.round(r.waitingS / 60))} λεπτό.</p>
              {r.text && <p>«{r.text}»</p>}
              <button className="btn btn--primary" data-on="accent" onClick={() => void accept(r)}>Αποδοχή</button>
            </section>
          ))}
        </>
      )}

      {(phase === "live" || phase === "joining") && (
        <>
          <p className="assist__state" data-state={conn}><strong>{stateText}</strong></p>
          <div className="assist__video" data-has-video={hasVideo}>
            <video ref={video} autoPlay playsInline aria-label="Η κάμερα του ανθρώπου που περπατά" />
            {!hasVideo && <p className="t-secondary">{conn === "connected" && mode === "audio" ? "Μόνο ήχος: δεν έρχεται εικόνα." : "Αναμονή εικόνας…"}</p>}
          </div>
          <section aria-labelledby="marks-h" className="assist__marks">
            <h2 id="marks-h">Σημειώστε τι βλέπετε</h2>
            {!personAt && <p>Περιμένω τη θέση από τον άνθρωπο, για να μπορέσετε να σημειώσετε.</p>}
            <div className="choices assist__grid">
              {MARKS.map((m) => (
                <button key={m.kind} className="btn" disabled={!personAt || marking} onClick={() => void mark(m.kind, m.label)}>{m.label}</button>
              ))}
            </div>
          </section>
          <div className="assist__controls">
            <button className="btn" aria-pressed={muted} onClick={toggleMute} disabled={!held.current.stream}>{muted ? "Άνοιγμα μικροφώνου" : "Σίγαση μικροφώνου"}</button>
            <button className="btn assist__end" onClick={() => void finish("Η κλήση τελείωσε.")}>Τέλος κλήσης</button>
          </div>
        </>
      )}

      {phase === "problem" && problem && (
        <section aria-labelledby="problem-h">
          <h2 id="problem-h">{problem.title}</h2>
          <ol>{problem.steps.map((s) => <li key={s}>{s}</li>)}</ol>
          <button className="btn btn--primary" data-on="accent" onClick={() => setPhase("list")}>Πίσω στη λίστα</button>
        </section>
      )}

      {phase === "ended" && (
        <section aria-labelledby="ended-h">
          <h2 id="ended-h">Η κλήση τελείωσε</h2>
          <button className="btn btn--primary" data-on="accent" onClick={() => { setPhase("list"); setRequests(null); }}>Πίσω στη λίστα</button>
        </section>
      )}

      <p className="assist__status t-secondary" role="status" aria-live="polite" aria-atomic="true">{status}</p>
      <p className="assist__note">{NO_RECORDING}</p>
    </main>
  );
}

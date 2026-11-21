import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowBendUpLeft, ArrowBendUpRight, ArrowUp, Flag, Microphone, PersonSimpleWalk } from "@phosphor-icons/react";
import { labels as signalLabels, phone as phoneDevice } from "../devices/signals";
import { metres, round5, turnView } from "../scenario/phrases";
import type { InstructionView, ScenarioState } from "../scenario/types";
import { useScenario } from "../scenario/useScenario";
import { synth } from "../sound/synth";
import { speak } from "../voice/speech";
import "./phone.css";

type View = "loading" | "ask" | "confirm" | "walk" | "alert" | "new_route" | "arrived";

interface Recognition extends EventTarget {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  abort(): void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}

function recognitionCtor(): (new () => Recognition) | null {
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function viewOf(state: ScenarioState, pending: boolean): View {
  if (pending || (!state.ready && state.phase === "idle")) return "loading";
  if (state.moment && !state.moment.replay) return state.moment.beat === "warn" ? "alert" : "new_route";
  switch (state.phase) {
    case "idle": return "ask";
    case "destination": return "confirm";
    case "arrived": return "arrived";
    default: return "walk";
  }
}

function DirectionIcon({ direction }: { direction: InstructionView["direction"] }) {
  const props = { weight: "bold" as const, "aria-hidden": true, className: "instruction__icon" };
  if (direction === "arrive") return <Flag {...props} />;
  if (direction === "crossing") return <PersonSimpleWalk {...props} />;
  if (direction?.endsWith("left")) return <ArrowBendUpLeft {...props} />;
  if (direction?.endsWith("right")) return <ArrowBendUpRight {...props} />;
  return <ArrowUp {...props} />;
}

function Instruction({ instruction }: { instruction: InstructionView | null }) {
  if (!instruction) return <h1 className="t-instruction" tabIndex={-1}>Συνεχίστε ευθεία</h1>;
  return (
    <>
      <DirectionIcon direction={instruction.direction} />
      <h1 className="t-instruction" tabIndex={-1}>{instruction.title}</h1>
      {instruction.distance && <p className="t-secondary instruction__distance">{instruction.distance}</p>}
    </>
  );
}

export function Phone() {
  const { state, dispatch, mode, problem } = useScenario("phone");
  const query = useMemo(() => new URLSearchParams(window.location.search), []);
  const presets = useMemo(() => {
    const given = query.get("presets")?.split("|").map((s) => s.trim()).filter(Boolean);
    return given?.length ? given.slice(0, 3) : [state.config.sentence, "Πήγαινέ με στο πιο κοντινό ΚΕΠ", "Θέλω να πάω στην Πολυκλινική Αθηνών"];
  }, [query, state.config.sentence]);
  const [typed, setTyped] = useState("");
  const [listening, setListening] = useState(false);
  const [local, setLocal] = useState("");
  const [vibration, setVibration] = useState<string>("");
  const recognition = useRef<Recognition | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const screen = useRef<HTMLElement>(null);
  const view = viewOf(state, mode === "pending");

  // One thing per screen: when the screen changes, focus goes to its heading.
  useEffect(() => {
    screen.current?.querySelector<HTMLElement>("h1")?.focus({ preventScroll: true });
  }, [view]);

  // The device layer: a turn, an obstacle and the arrival are also felt.
  const lastSignal = useRef<number | null>(state.signal?.id ?? null);
  useEffect(() => {
    const signal = state.signal;
    if (!signal || signal.id === lastSignal.current) return;
    lastSignal.current = signal.id;
    void phoneDevice.signal(signal.value).then((sent) => {
      setVibration(`${signalLabels[signal.value]}${sent ? "" : " (αυτή η συσκευή δεν δονείται)"}`);
    });
  }, [state.signal]);

  // A phone that follows a stage in another tab stays silent unless asked: two voices from one machine would overlap.
  const lastCaption = useRef<number | null>(null);
  const echo = mode === "follower" && query.get("voice") === "on";
  useEffect(() => {
    const caption = state.caption;
    if (!echo || !caption || caption.id === lastCaption.current) return;
    lastCaption.current = caption.id;
    speak(caption.text, { priority: caption.kind === "obstacle" ? 2 : 1 });
  }, [echo, state.caption]);

  useEffect(() => () => recognition.current?.abort(), []);

  const gesture = () => {
    synth.unlock();
  };
  const ask = (text: string) => {
    gesture();
    setLocal("");
    dispatch({ type: "setDestination", text });
  };
  const listen = () => {
    gesture();
    const Ctor = recognitionCtor();
    if (!Ctor) {
      setLocal("Η αναγνώριση ομιλίας δεν υπάρχει σε αυτόν τον browser. Γράψτε τον προορισμό ή επιλέξτε έναν από τους τρεις.");
      input.current?.focus();
      return;
    }
    recognition.current?.abort();
    const instance = new Ctor();
    recognition.current = instance;
    instance.lang = "el-GR";
    instance.interimResults = false;
    instance.maxAlternatives = 1;
    instance.onresult = (event) => {
      const said = event.results[0]?.[0]?.transcript?.trim();
      if (said) {
        setTyped(said);
        ask(said);
      }
    };
    instance.onerror = () => {
      setLocal("Δεν σας άκουσα. Δοκιμάστε ξανά, ή γράψτε τον προορισμό.");
    };
    instance.onend = () => setListening(false);
    setListening(true);
    setLocal("Ακούω. Πείτε τον προορισμό σας.");
    try {
      instance.start();
    } catch {
      setListening(false);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (typed.trim()) ask(typed);
  };

  // One speech channel per message: when this phone speaks by itself, the live region stays quiet.
  const ownVoice = mode === "host" && state.speech === "voice";
  const message = local || state.notice;
  const offline = state.connection === "offline" || state.localFallback;
  const destination = state.destination;
  const remaining = state.walker ? round5(state.walker.remainingM) : null;

  let body: ReactNode;
  switch (view) {
    case "loading":
      body = <h1 className="t-secondary" tabIndex={-1}>{problem ? `Ο χάρτης πεζών δεν φορτώθηκε. ${problem}` : "Φόρτωση του χάρτη πεζών."}</h1>;
      break;
    case "ask":
      body = (
        <>
          <h1 className="t-instruction" tabIndex={-1}>Πού θέλετε να πάτε;</h1>
          <button type="button" className="btn btn--primary" data-on="accent" onClick={listen} disabled={state.busy} aria-pressed={listening}>
            <Microphone weight="bold" aria-hidden="true" className="btn__icon" />
            {listening ? "Ακούω" : "Πείτε πού θέλετε να πάτε"}
          </button>
          <form className="stack" onSubmit={submit}>
            <label className="field">
              <span>Ή γράψτε τον προορισμό</span>
              <input ref={input} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" enterKeyHint="go" lang="el" />
            </label>
            <button type="submit" className="btn" disabled={state.busy || !typed.trim()}>Αναζήτηση</button>
          </form>
          <section className="stack" aria-labelledby="presets-title">
            <h2 id="presets-title" className="t-secondary">Έτοιμοι προορισμοί</h2>
            {presets.map((sentence) => (
              <button key={sentence} type="button" className="btn" disabled={state.busy} onClick={() => ask(sentence)}>{sentence}</button>
            ))}
          </section>
        </>
      );
      break;
    case "confirm":
      body = destination && (
        <>
          <p className="t-secondary">Προορισμός</p>
          <h1 className="t-instruction" tabIndex={-1}>{destination.name}</h1>
          {destination.address && <p className="t-secondary">{destination.address}</p>}
          {destination.local && <p>Από τον τοπικό κατάλογο OpenStreetMap, όχι από τον Δήμο.</p>}
          {destination.hospital && (
            <section className="emergency" aria-label="Έκτακτη ανάγκη">
              <p className="t-secondary">Αν είναι επείγον, καλέστε το 112.</p>
              <a className="btn" href="tel:112">Κλήση 112</a>
            </section>
          )}
          <button type="button" className="btn btn--primary" data-on="accent" disabled={state.busy} onClick={() => { gesture(); dispatch({ type: "start" }); }}>Ξεκινήστε</button>
          <button type="button" className="btn" disabled={state.busy} onClick={() => dispatch({ type: "clearDestination" })}>Άλλος προορισμός</button>
        </>
      );
      break;
    case "walk":
      body = (
        <>
          <div className="instruction"><Instruction instruction={state.instruction} /></div>
          {remaining !== null && destination && <p>Απομένουν {metres(remaining)} ως: {destination.name}.</p>}
          <button type="button" className="btn btn--primary btn--tall" data-on="accent" disabled={state.busy} onClick={() => { gesture(); dispatch({ type: "report", at: "walker" }); }}>Εμπόδιο εδώ</button>
        </>
      );
      break;
    case "alert":
      body = (
        <div className="alert">
          <span className="alert__ring" aria-hidden="true"><span className="alert__sign">!</span></span>
          <h1 className="alert__word t-alert-word" tabIndex={-1} lang="el">Εμπόδιο</h1>
          <p className="t-secondary">Στη διαδρομή σας, μπροστά.</p>
        </div>
      );
      break;
    case "new_route":
      body = (
        <div className="new-route">
          <p className="t-secondary">Η διαδρομή αλλάζει</p>
          <div className="instruction">
            <Instruction instruction={state.change && state.walker ? turnView(state.change.turn, state.change.divergeAtM - state.walker.distanceM) : state.instruction} />
          </div>
        </div>
      );
      break;
    case "arrived":
      body = (
        <>
          <Flag weight="bold" aria-hidden="true" className="instruction__icon" />
          <h1 className="t-instruction" tabIndex={-1}>Φτάσατε</h1>
          {destination && <p className="t-secondary">{destination.name}</p>}
          <button type="button" className="btn btn--primary" data-on="accent" onClick={() => dispatch({ type: "clearDestination" })}>Νέος προορισμός</button>
        </>
      );
      break;
  }

  return (
    <div className="phone" data-surface="phone" data-view={view} data-backdrop={view === "new_route" ? "accent" : undefined}>
      <header className="phone__top">
        <p className="phone__brand">ION Athens</p>
        <ul className="phone__tags" aria-label="Κατάσταση">
          {state.walker && <li className="chip">Θέση: προσομοίωση</li>}
          {mode === "follower" && <li className="chip">Ακολουθεί την οθόνη σκηνής</li>}
          {offline && <li className="chip chip--alert">ΕΚΤΟΣ ΣΥΝΔΕΣΗΣ · ΤΟΠΙΚΗ ΠΡΟΣΟΜΟΙΩΣΗ</li>}
          {state.paused && <li className="chip">Παύση</li>}
        </ul>
      </header>
      <main className="phone__screen" ref={screen}>{body}</main>
      <footer className="phone__foot">
        <p className="phone__message" role="status" aria-live={ownVoice && !local ? "off" : view === "alert" || view === "new_route" ? "assertive" : "polite"} aria-atomic="true">{message}</p>
        {vibration && <p className="phone__signal">Σήμα συσκευής: {vibration}</p>}
        <Link className="btn btn--quiet" to="/phone/devices">Ρυθμίσεις συσκευής</Link>
      </footer>
    </div>
  );
}

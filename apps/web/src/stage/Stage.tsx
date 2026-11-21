import { Choices } from "../profiles/Choices";
import { Compare } from "../profiles/Compare";
import { useEffect, useMemo, useRef, useState } from "react";
import { fetchSources } from "../scenario/browser";
import { captionSentences } from "../scenario/phrases";
import type { SourceInfo } from "../scenario/ports";
import type { Caption, Metrics, ScenarioState } from "../scenario/types";
import { prefersReducedMotion, useScenario } from "../scenario/useScenario";
import { labels as signalLabels } from "../devices/signals";
import { synth } from "../sound/synth";
import { StageMap } from "./StageMap";
import "./stage.css";

const KEYS: [string, string][] = [
  ["Enter", "Προορισμός, εκκίνηση, κλείσιμο μετά την άφιξη"],
  ["Α", "Εναρκτήρια φράση (πλήκτρο A)"],
  ["1", "Πρώτη αναφορά εμποδίου μπροστά στον πεζό"],
  ["2", "Επιβεβαίωση από άλλον άνθρωπο (ξανά, ώσπου να κλείσει το πεζοδρόμιο)"],
  ["3", "Το εμπόδιο απομακρύνθηκε"],
  ["0 μηδέν", "Επαναφορά σεναρίου"],
  ["C", "Σύγκριση τριών διαδρομών"],
  ["P", "Παύση και συνέχεια"],
  ["R", "Επανάληψη της στιγμής"],
  ["S", "Πηγές δεδομένων"],
  ["O όμικρον", "Ήχος ανοίγματος, 9 δευτερόλεπτα σε μαύρη οθόνη"],
  ["T", "Ήχος στροφής, 3 δευτερόλεπτα"],
  ["W", "Βήματα και μπαστούνι στο περπάτημα"],
  ["M", "Σίγαση ήχων"],
  ["?", "Αυτή η βοήθεια"],
];

/** Shown when /api/sources does not answer. */
const BUILT_IN_SOURCES: SourceInfo[] = [
  { id: "openstreetmap", name: "OpenStreetMap: το δίκτυο πεζών", owner: "OpenStreetMap contributors", data: "real", permission: "open licence" },
  { id: "ion-sandbox", name: "AthensGov Sandbox", owner: "Δήμος Αθηναίων", data: "test", permission: "not needed" },
  { id: "ion-demo", name: "Περιπατητής, εμπόδιο και ήχοι", owner: "Ομάδα ION Athens", data: "simulated", permission: "not needed" },
];

const DATA_EL: Record<string, string> = { real: "πραγματικά", test: "test data", simulated: "προσομοίωση" };
const PERMISSION_EL: Record<string, string> = { "open licence": "ανοιχτή άδεια", pending: "άδεια σε εκκρεμότητα", "not needed": "δεν χρειάζεται άδεια" };

function decimal(value: number, digits: number): string {
  return value.toLocaleString("el-GR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** The sentence being spoken, and how many of its words have been said. */
function currentSentence(caption: Caption): { words: string[]; said: number } {
  let before = 0;
  const sentences = captionSentences(caption.text);
  for (const words of sentences) {
    if (caption.revealed <= before + words.length) return { words, said: Math.max(0, caption.revealed - before) };
    before += words.length;
  }
  const last = sentences.at(-1) ?? [];
  return { words: last, said: last.length };
}

function CaptionBar({ state }: { state: ScenarioState }) {
  const { caption, phase, request } = state;
  const idle = phase === "idle" && !caption;
  const sentence = caption ? currentSentence(caption) : null;
  const length = sentence ? sentence.words.join(" ").length : request.length;
  // Two lines at the full size hold about 58 characters. A longer sentence steps down within the allowed range.
  const size = length > 76 ? "small" : length > 54 ? "medium" : "full";
  return (
    <footer className="caption" data-kind={caption?.kind ?? "none"}>
      <p className="caption__label">
        <span>{idle ? "Το αίτημα του πεζού" : "Η φωνή λέει"}</span>
        {caption && !caption.voiced && <span className="tag tag--solid">ΧΩΡΙΣ ΦΩΝΗ</span>}
        {idle && <span className="tag">Κείμενο, όχι μικρόφωνο</span>}
        {state.signal && !idle && <span className="tag caption__signal">Σήμα στη συσκευή: {signalLabels[state.signal.value]}</span>}
      </p>
      {/* The caption is the mirror of the voice. Screen readers get the sentence once, from the status region below. */}
      <p className="caption__text t-instruction" data-size={size} lang="el" aria-hidden="true">
        {idle && <span className="caption__quote">«{request}»</span>}
        {sentence?.words.map((word, i) => (
          <span key={`${caption!.id}-${i}`} className="caption__word" data-said={i < sentence.said}>
            {word}{" "}
          </span>
        ))}
      </p>
      <p className="visually-hidden" role="status">{caption?.text ?? ""}</p>
    </footer>
  );
}

function MetricsPanel({ metrics }: { metrics: Metrics }) {
  const from =
    metrics.measuredFrom === "request"
      ? "από την επιβεβαίωση ως τη νέα διαδρομή"
      : metrics.measuredFrom === "event"
        ? "από το συμβάν του διακομιστή ως τη νέα διαδρομή"
        : "υπολογισμός στον browser, χωρίς διακομιστή";
  return (
    <aside className="metrics" aria-label="Μετρήσεις της αλλαγής διαδρομής">
      <p className="metrics__row">
        <span className="metrics__number">{decimal(metrics.reportToRouteS, metrics.reportToRouteS < 10 ? 2 : 1)}</span>
        <span className="metrics__unit">δευτερόλεπτα</span>
        <span className="metrics__what">{from}</span>
      </p>
      {metrics.warningM !== null && (
        <p className="metrics__row">
          <span className="metrics__number">{Math.round(metrics.warningM)}</span>
          <span className="metrics__unit">μέτρα</span>
          <span className="metrics__what">προειδοποίηση πριν από τη στροφή</span>
        </p>
      )}
    </aside>
  );
}

const SOURCE_ROWS = 16; // what fits on a 16:9 stage at the smallest allowed type

function SourcesPanel({ sources, builtIn }: { sources: SourceInfo[]; builtIn: "waiting" | "failed" | null }) {
  const shown = sources.slice(0, SOURCE_ROWS);
  const more = sources.length - shown.length;
  return (
    <section className="overlay sources" aria-label="Πηγές δεδομένων">
      <h2 className="overlay__title overlay__title--small">
        Πηγές: {sources.length}
        {builtIn === "failed" && <span className="tag">Ενσωματωμένη λίστα, το /api/sources δεν απάντησε</span>}
        {builtIn === "waiting" && <span className="tag">Ενσωματωμένη λίστα, αναμονή του /api/sources</span>}
        {more > 0 && <span className="tag">Εδώ οι πρώτες {shown.length}</span>}
      </h2>
      <table className="sources__table">
        <thead>
          <tr><th scope="col">Πηγή</th><th scope="col">Φορέας</th><th scope="col">Δεδομένα</th><th scope="col">Άδεια χρήσης</th></tr>
        </thead>
        <tbody>
          {shown.map((s, i) => (
            <tr key={`${s.id}-${i}`} data-down={s.answering === false}>
              <th scope="row">{s.name}</th>
              <td>{s.owner}</td>
              <td>{DATA_EL[s.data ?? ""] ?? s.data ?? "άγνωστο"}{s.answering === false ? ", δεν απαντά" : ""}</td>
              <td>{PERMISSION_EL[s.permission ?? ""] ?? s.permission ?? "άγνωστο"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function Stage() {
  const walkingSound = useRef(true);
  const { state, dispatch, problem } = useScenario("stage", { walkingSound: () => walkingSound.current });
  const query = useMemo(() => new URLSearchParams(window.location.search), []);
  const [compare, setCompare] = useState(false);
  const [help, setHelp] = useState(false);
  const [showSources, setShowSources] = useState(false);
  // undefined: no answer yet. null: the server did not answer.
  const [sources, setSources] = useState<SourceInfo[] | null | undefined>(undefined);
  const [statement, setStatement] = useState(false);
  const [opening, setOpening] = useState(false);
  const [sound, setSound] = useState<"locked" | "on" | "muted">("locked");
  const [reducedMotion, setReducedMotion] = useState(prefersReducedMotion);
  const moving = !state.waiting && !state.paused && ["walking", "reported", "rerouting", "walking_new", "restored"].includes(state.phase);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  // Asked once when the stage opens, so the panel is ready, and again each time it is shown.
  useEffect(() => {
    let current = true;
    void fetchSources().then((list) => {
      if (current) setSources((previous) => list ?? previous ?? null);
    });
    return () => {
      current = false;
    };
  }, [showSources]);

  // Sound may start only from a gesture: the first key or click unlocks it.
  useEffect(() => {
    const unlock = () => {
      if (synth.unlock()) setSound((s) => (s === "locked" ? "on" : s));
    };
    window.addEventListener("pointerdown", unlock);
    return () => window.removeEventListener("pointerdown", unlock);
  }, []);

  useEffect(() => {
    synth.setWalking(moving && walkingSound.current && !state.moment);
  }, [moving, state.moment]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
      if (synth.unlock()) setSound((s) => (s === "locked" ? "on" : s));
      // Physical keys, so a Greek keyboard layout works too.
      const key = event.key === "?" ? "Help" : event.code;
      if (compare && (key === "Escape" || key === "KeyC")) { setCompare(false); event.preventDefault(); return; }
      if (compare || ((key === "Enter" || key === "Space") && event.target instanceof HTMLButtonElement)) return;
      if (statement && ["Enter", "Space", "NumpadEnter", "Escape", "KeyA"].includes(key)) {
        setStatement(false); event.preventDefault(); return;
      }
      switch (key) {
        case "KeyA": setOpening(false); setStatement(true); break;
        case "KeyC": setCompare(true); setHelp(false); setShowSources(false); break;
        case "Enter": case "NumpadEnter": case "Space": dispatch({ type: "advance" }); break;
        case "Digit1": case "Numpad1": dispatch({ type: "report", at: "ahead" }); break;
        case "Digit2": case "Numpad2": dispatch({ type: "confirm" }); break;
        case "Digit3": case "Numpad3": dispatch({ type: "resolve" }); break;
        case "Digit0": case "Numpad0": dispatch({ type: "reset" }); break;
        case "KeyP": dispatch({ type: "pause" }); break;
        case "KeyR": dispatch({ type: "replay" }); break;
        case "KeyS": setShowSources((v) => !v); setHelp(false); break;
        case "KeyO": {
          const ms = synth.opening();
          if (ms > 0) {
            setOpening(true);
            window.setTimeout(() => setOpening(false), ms);
          }
          break;
        }
        case "KeyT": synth.turn(true); break;
        case "KeyW":
          walkingSound.current = !walkingSound.current;
          synth.setWalking(walkingSound.current && moving);
          break;
        case "KeyM":
          synth.setMuted(!synth.muted);
          setSound(synth.muted ? "muted" : "on");
          break;
        case "Help": case "KeyH": case "F1": setHelp((v) => !v); setShowSources(false); break;
        case "Escape": setHelp(false); setShowSources(false); setOpening(false); break;
        default: return;
      }
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dispatch, moving, compare, statement]);

  const beat = state.moment?.beat ?? "none";
  const offline = state.connection === "offline" || state.localFallback;
  const scale = decimal(state.timeScale, Number.isInteger(state.timeScale) ? 0 : 1);
  const steps = state.route?.steps ?? [];
  const tiles = query.get("tiles") !== "off";
  const metricsShown = state.metrics !== null && state.phase !== "rerouting";

  const comparisonQuery = useMemo(() => {
    const next = new URLSearchParams(query);
    if (state.loop) {
      for (const [key, p] of [["compareFrom", state.loop.start], ["compareTo", state.loop.destination]] as const)
        if (!next.has(key)) next.set(key, [p.lng,p.lat].join(","));
    }
    return next;
  }, [state.loop, query]);

  if (state.closing) return <main className="pitch-frame">
    <div className="pitch-seats" aria-label="Δύο καθίσματα θεάτρου"><i/><i/></div>
    <p>Το θέατρο ήταν πάντα εκεί. Ο δρόμος ως την πόρτα του δεν ήταν γραμμένος πουθενά.</p>
    <strong>Απόψε τον έγραψε η πόλη.</strong>
  </main>;
  if (statement) return <main className="pitch-frame"><p>Δεν υπάρχουν «άνθρωποι με ειδικές ανάγκες». Υπάρχουν άνθρωποι με αναπηρία, και πόλεις που ακόμη τους βάζουν εμπόδια.</p></main>;
  return (
    <div className="stage" data-surface="stage" data-moment={beat} data-phase={state.phase} data-metrics={metricsShown}>
      <header className="stage__top" inert={compare}>
        <p className="stage__brand">ION Athens</p>
        <ul className="provenance" aria-label="Τι είναι πραγματικό και τι όχι">
          {/* Only what keeps the screen honest stays here. Where the data comes from is in the sources panel (key S) and on the About page. */}
          <li className="plate"><span className="plate__name">Περιπατητής</span><span className="plate__state">ΠΡΟΣΟΜΟΙΩΣΗ{state.route ? ` ×${scale}` : ""}</span></li>
        </ul>
      </header>

      <main className="stage__map" inert={compare} hidden={state.phase === "arrived" && !!state.card}>
        <StageMap state={state} reducedMotion={reducedMotion} tiles={tiles} />

        <div className="stage__flags">
          {state.crossingNotice && !state.change && !state.waiting && <p className="flag crossing-answer" role="status">{state.crossingNotice}</p>}
          {state.loopFallback && <p className="flag">Εφεδρικό σενάριο · Δημαρχείο</p>}
          {state.injected && <p className="flag">ΕΠΙΔΕΙΞΗ</p>}
          {state.waiting && <p className="flag" role="status">Αναμονή επιβεβαίωσης από δημότη</p>}
          {offline && <p className="flag flag--alert">ΕΚΤΟΣ ΣΥΝΔΕΣΗΣ · ΤΟΠΙΚΗ ΠΡΟΣΟΜΟΙΩΣΗ</p>}
          {state.moment?.replay && <p className="flag">ΕΠΑΝΑΛΗΨΗ</p>}
          {state.paused && <p className="flag">ΠΑΥΣΗ</p>}
          {problem && <p className="flag flag--alert">Ο χάρτης πεζών δεν φορτώθηκε: {problem}</p>}
        </div>

        {state.metrics && metricsShown && <MetricsPanel metrics={state.metrics} />}

        <ul className="toasts" aria-label="Κλήσεις προς τον διακομιστή">
          {state.toasts.map((toast) => (
            <li key={toast.id} className="toast" data-tone={toast.tone}>{toast.text}</li>
          ))}
        </ul>

        <p className="stage__foot">
          {state.phase === "idle" && <span className="tag">Πλήκτρα: ?</span>}
          {state.phase === "idle" && <span className="tag">{sound === "muted" ? "Ήχος: σίγαση" : sound === "locked" ? "Ήχος: μετά το πρώτο πλήκτρο" : "Ήχος συνθετικός"}</span>}
        </p>

        <ol className="visually-hidden" aria-label="Η διαδρομή σε βήματα">
          {steps.map((step, i) => (
            <li key={i}>
              {Math.round(step.atDistanceM)} μέτρα: {step.kind === "depart" ? "εκκίνηση" : step.kind === "arrive" ? "άφιξη" : step.kind === "crossing" ? "διάβαση πεζών" : `στροφή ${step.direction ?? ""}`}
              {step.onto ? `, ${step.onto}` : ""}
            </li>
          ))}
        </ol>
      </main>

      {state.phase === "arrived" && state.card && <section className="venue-reveal" aria-label="Καρτέλα χώρου">
        <h2>{state.card.name}</h2>
        <dl>{state.card.facts.map(f => <div key={f.key + f.entranceId}>
          <dt>{f.question}</dt><dd>{f.key === "step_count" && f.source === "openstreetmap"
            ? f.value + " σκαλιά" : ({yes:"ναι", no:"όχι", limited:"μερικώς"}[f.value ?? ""] ?? f.value ?? "άγνωστο")}
            {f.source === "citizens" && <small> · από δημότες</small>}</dd>
        </div>)}</dl>
      </section>}
      {state.ready && state.phase === "idle" && !state.caption && !compare ? <Choices value={state.profile} onChoose={profile => {
        dispatch({ type: "chooseProfile", profile });
        dispatch({ type: "advance" });
      }} /> : <CaptionBar state={state} />}
      {compare && <Compare query={comparisonQuery} close={() => setCompare(false)} />}

      {showSources && <SourcesPanel sources={sources ?? BUILT_IN_SOURCES} builtIn={sources === undefined ? "waiting" : sources === null ? "failed" : null} />}
      {help && (
        <section className="overlay help" aria-label="Πλήκτρα παρουσιαστή">
          <h2 className="overlay__title overlay__title--small">Πλήκτρα παρουσιαστή</h2>
          <p>Με ?citizen=live η σκηνή ακούει το κινητό (αυτόματα με room). Με ?citizen=scripted χρησιμοποιήστε 1 και 2.</p>
          <dl className="help__keys">
            {KEYS.map(([key, what]) => (
              <div key={key} className="help__row"><dt><kbd>{key}</kbd></dt><dd>{what}</dd></div>
            ))}
          </dl>
        </section>
      )}
      {opening && <div className="blackout"><p className="tag">Ήχος συνθετικός, όχι ηχογράφηση</p></div>}
    </div>
  );
}

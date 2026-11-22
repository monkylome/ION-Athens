import { haversineM } from "@ion/core";
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
  const idle = (phase === "idle" || phase === "destination") && !caption;
  const sentence = caption ? currentSentence(caption) : null;
  const length = sentence ? sentence.words.join(" ").length : request.length;
  // Two lines at the full size hold about 58 characters. A longer sentence steps down within the allowed range.
  const size = length > 76 ? "small" : length > 54 ? "medium" : "full";
  return (
    <footer className="caption" data-kind={caption?.kind ?? "none"}>
      <p className="caption__label">
        <span>{idle ? "Προορισμός" : "Η φωνή λέει"}</span>
        {caption && !caption.voiced && <span className="tag tag--solid">ΧΩΡΙΣ ΦΩΝΗ</span>}

        {state.signal && !idle && <span className="tag caption__signal">Σήμα στη συσκευή: {signalLabels[state.signal.value]}</span>}
      </p>
      {/* The caption is the mirror of the voice. Screen readers get the sentence once, from the status region below. */}
      <p className="caption__text t-instruction" data-size={size} lang="el" aria-hidden="true">
        {idle && <span className="caption__quote">{state.loop?.destination.name ?? request}</span>}
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
      <p className="metrics__row"><span className="metrics__number">{Math.round(metrics.extraM)}</span><span className="metrics__what">μέτρα επιπλέον</span></p>
    </aside>
  );
}

const kinds = ["ζωντανά", "ημερήσια", "αρχείο", "δοκιμαστικά"] as const;
function sourceKind(s: SourceInfo) {
  if (s.kind === "live") return kinds[0];
  if (s.kind === "daily") return kinds[1];
  return s.data === "real" ? kinds[2] : kinds[3];
}
function SourcesPanel({ sources, builtIn, stepCount }: { stepCount: number; sources: SourceInfo[]; builtIn: "waiting" | "failed" | null }) {
  const sorted = [...sources].sort((a,b)=>kinds.indexOf(sourceKind(a))-kinds.indexOf(sourceKind(b)));
  return <section className="overlay sources" aria-label="Πηγές δεδομένων">
    <h2 className="overlay__title overlay__title--small">Πηγές: {sources.length}</h2>
    <p>{kinds.map(k=>sources.filter(s=>sourceKind(s)===k).length+" "+k).join(" · ")}
      {stepCount > 0 && " · Διαδρομή 2: "+stepCount+" κοντινά σημεία"}
      {builtIn && " · Ενσωματωμένη λίστα"}
    </p>
    <table className="sources__table"><tbody>{sorted.map(s=><tr key={s.id}>
      <th scope="row">{s.name}</th><td>{sourceKind(s)}{s.kind === "live" && s.data === "test" && " · δοκιμαστικά"}</td>
      <td>{s.kind === "live" && s.lastFetched && "πριν από "+Math.max(0, Math.round((Date.now()-Date.parse(s.lastFetched))/1000))+"″ "}
        {s.answering === false && "δεν απαντά "}{s.permission === "pending" && "άδεια σε εκκρεμότητα"}</td>
    </tr>)}</tbody></table>
  </section>;
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
  const position = state.walker?.position ?? (state.start ? [state.start.lng,state.start.lat] as const : null);
  const step = position ? state.loop?.steps?.map(s=>({order:s.order,d:haversineM(position,s.position)}))
    .filter(s=>s.d<=65).sort((a,b)=>a.d-b.d)[0] : null;
  const museum = state.loop?.museumCard;
  const museumDistance = museum && position ? Math.round(Math.min(...museum.positions.map(p=>haversineM(position,p)))) : Infinity;
  const lift = state.loop?.lift;
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
    <p>Ἰών. Αυτός που πηγαίνει.</p><small>ION Athens</small>
  </main>;
  if (statement) return <main className="pitch-frame"><p>«Από την πόρτα του ανελκυστήρα ξεκινάει ο οδηγός όδευσης τυφλών.»</p><small>Δήμος Αθηναίων · Με Άλλα Μάτια · This is Athens: Προσβάσιμες Διαδρομές, Βόλτα στην Ακρόπολη</small></main>;
  return (
    <div className="stage" data-surface="stage" data-moment={beat} data-phase={state.phase} data-metrics={metricsShown}>
      <header className="stage__top" inert={compare}>
        <p className="stage__brand">ION Athens</p>
        <ul className="provenance" aria-label="Τι είναι πραγματικό και τι όχι">
          {/* Only what keeps the screen honest stays here. Where the data comes from is in the sources panel (key S) and on the About page. */}
        </ul>
      </header>

      <main className="stage__map" inert={compare} hidden={state.phase === "arrived" && !!state.card}>
        <StageMap state={state} reducedMotion={reducedMotion} tiles={tiles} />

        <div className="stage__flags">
          {museum && museumDistance <= 80 && <aside className="flag" aria-label="Κοντινή καρτέλα χώρου">
            {museum.name} · {museumDistance} μ.
            {museum.facts.filter(f=>f.value === "yes" && f.source === "openstreetmap" && ["wheelchair","toilets:wheelchair"].includes(f.key))
              .map(f=><span key={f.key}> · {f.key === "wheelchair" ? "πρόσβαση με αμαξίδιο" : "προσβάσιμη τουαλέτα"} (OSM)</span>)}
          </aside>}
          {step && <p className="flag">Κοντά σε σημείο της Προσβάσιμης Διαδρομής 2 του Δήμου, βήμα {step.order} · This is Athens / Δήμος Αθηναίων, 2021, άδεια σε εκκρεμότητα</p>}
          {lift && !state.walker && <p className="flag">ΣΤΑΣΥ · Σταθμός Ακρόπολη · {lift.working}/{lift.total} ανελκυστήρες σε λειτουργία · {new Date(lift.fetchedAt).toLocaleTimeString("el-GR",{timeZone:"Europe/Athens"})}</p>}
          {state.discoveryNotice && <p className="flag crossing-answer" role="status">{state.discoveryNotice.label} · Ανακάλυψη από την κάμερα · {state.discoveryNotice.seenBy} δημότες</p>}
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
            {f.source === "openstreetmap" && <small> · OpenStreetMap</small>}{f.source === "citizens" && <small> · από δημότες</small>}</dd>
        </div>)}</dl>
      </section>}
      {state.ready && state.phase === "idle" && !state.caption && !compare ? <Choices value={state.profile} onChoose={profile => {
        dispatch({ type: "chooseProfile", profile });
        dispatch({ type: "advance" });
      }} /> : <CaptionBar state={state} />}
      {compare && <Compare query={comparisonQuery} close={() => setCompare(false)} />}

      {showSources && <SourcesPanel stepCount={state.loop?.steps?.length ?? 0} sources={sources ?? BUILT_IN_SOURCES} builtIn={sources === undefined ? "waiting" : sources === null ? "failed" : null} />}
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

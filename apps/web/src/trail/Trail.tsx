import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { speak, cancelSpeech } from "../voice/speech";
import { useTrailRecorder } from "./useTrailRecorder";
import { confirmTrail, loadTrails, saveTrail, stepLengthStored, storeStepLength, type TrailRecord } from "./api";
import { describeSegment, describeTrail, startOptions, targetOptions } from "./describe";
import { compareTrails } from "./confirm";
import { defaultStepLength, metresFor, type Segment, type Side } from "./segments";
import type { TurnKind } from "./turns";
import "./trail.css";

const other = "__other";
const quickNotes = ["προσοχή, ένα σκαλί", "προσοχή, σκαλιά", "πόρτα", "βαριά πόρτα"];
const turnLabels: Record<TurnKind, string> = { straight: "Ευθεία", left: "Στρίψτε αριστερά", right: "Στρίψτε δεξιά", back: "Μεταβολή" };
const sideLabels: Record<Side, string> = { left: "Αριστερά", ahead: "Μπροστά", right: "Δεξιά" };

const Honesty = () => (
  <p className="trail__honesty" lang="el">
    Η διαδρομή είναι περιγραφή από έναν άνθρωπο που την περπάτησε. Οι αποστάσεις είναι κατά προσέγγιση. Από το κινητό φεύγει μόνο η περιγραφή.
  </p>
);

function Choice({ legend, options, value, onChange }: { legend: string; options: readonly string[]; value: string; onChange: (v: string) => void }) {
  const known = options.includes(value);
  return (
    <fieldset>
      <legend>{legend}</legend>
      <label>
        <span className="visually-hidden">{legend}</span>
        <select value={known ? value : other} onChange={e => onChange(e.target.value === other ? "" : e.target.value)}>
          {options.map(o => <option key={o} value={o}>{o}</option>)}
          <option value={other}>Άλλο, γράψτε το</option>
        </select>
      </label>
      {!known && (
        <label>
          Όνομα
          <input value={value} maxLength={100} onChange={e => onChange(e.target.value)} />
        </label>
      )}
    </fieldset>
  );
}

export function Trail() {
  const [params] = useSearchParams();
  const venue = params.get("venue") ?? "demo";
  const name = params.get("name") ?? "";
  const simulated = params.get("sim") === "1";
  const confirmId = params.get("confirm");
  const [start, setStart] = useState<string>(startOptions[0]);
  const [target, setTarget] = useState<string>(targetOptions[0]);
  const [stepLength, setStepLength] = useState(stepLengthStored() ?? defaultStepLength);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [reference, setReference] = useState<TrailRecord>();
  const [referenceProblem, setReferenceProblem] = useState("");
  const recorder = useTrailRecorder({ stepLength, simulated });
  const confirming = confirmId !== null;
  const trailStart = reference?.start ?? start;
  const trailTarget = reference?.target ?? target;

  useEffect(() => {
    if (!confirming) return;
    let cancelled = false;
    void loadTrails(venue).then(trails => {
      if (cancelled) return;
      const found = confirmId === "1" || confirmId === "" ? trails.find(t => !t.confirmed) : trails.find(t => t.id === confirmId);
      if (found) setReference(found);
      else setReferenceProblem("Δεν βρέθηκε διαδρομή για επιβεβαίωση σε αυτόν τον χώρο.");
    });
    return () => { cancelled = true; };
  }, [confirming, confirmId, venue]);

  useEffect(() => () => cancelSpeech(), []);
  useEffect(() => { if (recorder.event) setStatus(recorder.event); }, [recorder.event]);

  const description = useMemo(() => describeTrail({ start: trailStart, target: trailTarget, segments }), [trailStart, trailTarget, segments]);

  function finish() {
    setSegments(recorder.stop());
    setStatus("Η καταγραφή τελείωσε. Ελέγξτε την περιγραφή.");
  }

  function edit(index: number, change: Partial<Segment>) {
    setSegments(list => list.map((s, i) => {
      if (i !== index) return s;
      const next: Segment = { ...s, ...change };
      next.metres = metresFor(next.steps, stepLength);
      if (!next.note) delete next.note;
      if (!next.checkpoint) delete next.checkpoint;
      return next;
    }));
  }

  function calibrate() {
    const total = segments.reduce((sum, s) => sum + s.steps, 0);
    if (total < 4) return;
    const length = Math.min(1.2, Math.max(0.3, 10 / total));
    setStepLength(length);
    storeStepLength(length);
    setSegments(list => list.map(s => ({ ...s, metres: metresFor(s.steps, length) })));
    setStatus(`Το βήμα σας υπολογίστηκε περίπου ${Math.round(length * 100)} εκατοστά.`);
  }

  async function save() {
    setBusy(true);
    try {
      if (confirming && reference) {
        const result = compareTrails(reference.segments, segments);
        if (!result.ok) { setStatus(`Δεν επιβεβαιώθηκε. ${result.message} Η διαδρομή μένει ανεπιβεβαίωτη.`); return; }
        const where = await confirmTrail(venue, reference.id);
        setStatus(where === "server" ? "Η διαδρομή ταιριάζει και επιβεβαιώθηκε." : "Η διαδρομή ταιριάζει. Η επιβεβαίωση μένει μόνο σε αυτό το κινητό.");
      } else {
        const result = await saveTrail(venue, trailStart.trim(), trailTarget.trim(), segments);
        setStatus(result.where === "server" ? "Η διαδρομή αποθηκεύτηκε. Περιμένει δεύτερο πολίτη να την περπατήσει." : "Ο διακομιστής δεν απάντησε για αυτόν τον χώρο. Η διαδρομή αποθηκεύτηκε μόνο σε αυτό το κινητό.");
      }
    } catch (error) {
      setStatus(`Δεν αποθηκεύτηκε: ${error instanceof Error ? error.message : "άγνωστο σφάλμα"}.`);
    } finally {
      setBusy(false);
    }
  }

  const { state } = recorder;
  const heading = confirming ? "Επιβεβαίωση διαδρομής" : "Καταγραφή διαδρομής";
  const canStart = trailStart.trim() !== "" && trailTarget.trim() !== "" && (!confirming || !!reference);

  return (
    <main className="page trail" data-surface="phone" lang="el">
      <Link className="btn page__back" to="/">Αρχική</Link>
      <header className="stack">
        <h1>{heading}</h1>
        {name && <p className="page__lead">{name}</p>}
        {simulated && <p className="trail__sim t-alert-word" role="note">ΠΡΟΣΟΜΟΙΩΣΗ</p>}
        {simulated && <p>Δεν διαβάζονται αισθητήρες. Παίζει μια σκηνοθετημένη διαδρομή: 12 βήματα, στροφή αριστερά, 6 βήματα.</p>}
      </header>

      <p className="visually-hidden" role="status" aria-live="polite">{status}</p>

      {(state === "idle" || state === "unsupported" || state === "denied") && (
        <>
          {state === "unsupported" && <p className="trail__problem" role="alert">Αυτή η συσκευή ή αυτή η σελίδα δεν δίνει αισθητήρες κίνησης. Χρειάζεται Chrome σε Android και ασφαλή σύνδεση (https). Δοκιμάστε με ?sim=1 για την προσομοίωση.</p>}
          {state === "denied" && <p className="trail__problem" role="alert">Δεν δόθηκε άδεια για τους αισθητήρες κίνησης. Δώστε την άδεια στις ρυθμίσεις του προγράμματος περιήγησης και ξαναπροσπαθήστε.</p>}
          {referenceProblem && <p className="trail__problem" role="alert">{referenceProblem}</p>}
          {confirming ? (
            <section aria-label="Διαδρομή προς επιβεβαίωση">
              <p>Περπατήστε την ίδια διαδρομή από «{reference?.start ?? "…"}» προς «{reference?.target ?? "…"}», με τον ίδιο τρόπο.</p>
            </section>
          ) : (
            <>
              <Choice legend="Αφετηρία" options={startOptions} value={start} onChange={setStart} />
              <Choice legend="Προορισμός" options={targetOptions} value={target} onChange={setTarget} />
            </>
          )}
          <p className="page__lead">Κρατήστε το κινητό μπροστά σας και περπατήστε κανονικά</p>
          <p>Κρατήστε το οριζόντια, με την οθόνη προς τα πάνω και την πάνω άκρη προς εκεί που περπατάτε, στο ύψος της ζώνης ή του στήθους. Όχι στην τσέπη, όχι στο χέρι που κουνιέται.</p>
          <label className="field">
            Μήκος βήματος σε εκατοστά
            <input type="number" inputMode="numeric" min={30} max={120} value={Math.round(stepLength * 100)}
              onChange={e => { const v = Number(e.target.value) / 100; if (v >= 0.3 && v <= 1.2) { setStepLength(v); storeStepLength(v); } }} />
          </label>
          <button type="button" className="btn btn--primary btn--tall" disabled={!canStart} onClick={() => void recorder.start()}>Έναρξη</button>
          <Honesty />
        </>
      )}

      {state === "recording" && (
        <>
          <section aria-label="Βήματα" className="trail__counter">
            <p className="trail__count" aria-hidden="true">{recorder.steps}</p>
            <p className="t-secondary">βήματα<span className="visually-hidden">: {recorder.steps}</span></p>
            <p>Στροφή τώρα: {recorder.headingChange > 0 ? "αριστερά" : recorder.headingChange < 0 ? "δεξιά" : "καμία"} {Math.abs(recorder.headingChange)} μοίρες</p>
          </section>
          <section aria-label="Τμήματα μέχρι τώρα">
            <h2>Τμήματα</h2>
            {recorder.segments.length === 0 ? <p>Περπατήστε. Το πρώτο τμήμα θα εμφανιστεί μετά από λίγα βήματα.</p> : (
              <ol className="trail__segments">
                {recorder.segments.map((s, i) => <li key={i}>{describeSegment(s, i)}{s.note ? `, ${s.note}` : ""}</li>)}
              </ol>
            )}
          </section>
          <button type="button" aria-expanded={noteOpen} onClick={() => setNoteOpen(open => !open)}>Προσθήκη σημείωσης</button>
          {noteOpen && (
            <fieldset>
              <legend>Σημείωση για το σημείο που βρίσκεστε</legend>
              <div className="choices">
                {quickNotes.map(n => <button key={n} type="button" onClick={() => { recorder.addNote(n); setNoteOpen(false); }}>{n}</button>)}
              </div>
              <label>
                Άλλη σημείωση
                <input value={noteText} maxLength={150} onChange={e => setNoteText(e.target.value)} />
              </label>
              <button type="button" disabled={!noteText.trim()} onClick={() => { recorder.addNote(noteText.trim()); setNoteText(""); setNoteOpen(false); }}>Προσθήκη</button>
            </fieldset>
          )}
          <fieldset>
            <legend>Ο προορισμός είναι εδώ</legend>
            <div className="trail__sides">
              {(["left", "ahead", "right"] as Side[]).map(side => (
                <button key={side} type="button" onClick={() => recorder.addCheckpoint(side)}>{sideLabels[side]}</button>
              ))}
            </div>
          </fieldset>
          <button type="button" className="btn btn--primary btn--tall" onClick={finish}>Τέλος</button>
          <Honesty />
        </>
      )}

      {state === "done" && (
        <>
          <section aria-label="Η περιγραφή">
            <h2>Η περιγραφή</h2>
            <p className="trail__text">{description}</p>
          </section>
          <button type="button" onClick={() => speak(description, { priority: 1 })}>Ακούστε το</button>
          <section aria-label="Διόρθωση τμημάτων" className="trail__plain">
            <h2>Διόρθωση</h2>
            {segments.length === 0 && <p>Δεν καταγράφηκαν τμήματα. Ξαναπροσπαθήστε.</p>}
            {segments.map((s, i) => (
              <fieldset key={i}>
                <legend>Τμήμα {i + 1}</legend>
                <p>{describeSegment(s, i)}</p>
                <div className="trail__stepper">
                  <button type="button" aria-label={`Τμήμα ${i + 1}: λιγότερα βήματα`} disabled={s.steps <= 0} onClick={() => edit(i, { steps: s.steps - 1 })}>−</button>
                  <p aria-live="polite">{s.steps} βήματα</p>
                  <button type="button" aria-label={`Τμήμα ${i + 1}: περισσότερα βήματα`} disabled={s.steps >= 500} onClick={() => edit(i, { steps: s.steps + 1 })}>+</button>
                </div>
                {i > 0 && (
                  <label>
                    Στροφή πριν από το τμήμα
                    <select value={s.turn} onChange={e => edit(i, { turn: e.target.value as TurnKind })}>
                      {(Object.keys(turnLabels) as TurnKind[]).map(t => <option key={t} value={t}>{turnLabels[t]}</option>)}
                    </select>
                  </label>
                )}
                <label>
                  Ο προορισμός είναι σε αυτό το τμήμα
                  <select value={s.checkpoint ?? ""} onChange={e => edit(i, { checkpoint: (e.target.value || undefined) as Side | undefined })}>
                    <option value="">Όχι</option>
                    {(["left", "ahead", "right"] as Side[]).map(side => <option key={side} value={side}>{sideLabels[side]}</option>)}
                  </select>
                </label>
                <label>
                  Σημείωση
                  <input value={s.note ?? ""} maxLength={150} onChange={e => edit(i, { note: e.target.value })} />
                </label>
              </fieldset>
            ))}
            <button type="button" disabled={segments.reduce((n, s) => n + s.steps, 0) < 4} onClick={calibrate}>Περπάτησα ακριβώς 10 μέτρα: μέτρηση βήματος</button>
            <p>Μήκος βήματος τώρα: περίπου {Math.round(stepLength * 100)} εκατοστά.</p>
          </section>
          <button type="button" className="btn btn--primary btn--tall" disabled={busy || segments.length === 0} onClick={() => void save()}>
            {confirming ? "Επιβεβαίωση" : "Αποθήκευση"}
          </button>
          <button type="button" onClick={() => { cancelSpeech(); recorder.reset(); setSegments([]); }}>Νέα καταγραφή</button>
          <Honesty />
        </>
      )}
    </main>
  );
}

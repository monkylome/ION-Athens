import { useCallback, useEffect, useRef, useState } from "react";
import { cancelSpeech, speak } from "../voice/speech";
import { request } from "../api/client";
import { CompareMap } from "../profiles/Compare";
import { advance, labels, venuePath, type Card, type State } from "./flow";
import "./walkthrough.css";

const lines = [
  "«Θέλω να πάω στο Σεράφειο.»",
  "Έχει ανελκυστήρα;",
  "Κάποιος το χρειάζεται",
  "Δύο διαφορετικοί δημότες επιβεβαίωσαν τις απαντήσεις επίδειξης.",
  "Διαδρομή προς το Σεράφειο",
];
function StepIllustration({ step }: { step: number }) {
  const [loaded, setLoaded] = useState(false);
  return <figure className="ion-walk-illustration" hidden={!loaded}>
    <img src={`/walkthrough/step-${step}.webp`} alt="" onLoad={() => setLoaded(true)} />
    <figcaption>Εικόνα επίδειξης</figcaption>
  </figure>;
}

export function Walkthrough() {
  const [state,setState] = useState<State>({step:0});
  const [notice,setNotice] = useState("");
  const [busy,setBusy] = useState(false);
  const working = useRef(false);
  const version = useRef(0);
  const actors = useRef<string[]>([]);
  const next = useCallback(async () => {
    if (working.current || state.step>=6) return;
    working.current = true;
    version.current++;
    setBusy(true);
    setNotice("");
    try {
      if (!actors.current.length) actors.current = Array.from({length:3},()=>crypto.randomUUID());
      const updated = await advance(state, request, actors.current);
      setState(updated);
      if (updated.step === 6 && updated.speech) speak(updated.speech);
    } catch(error) {
      setNotice(error instanceof Error ? error.message : "Η ενέργεια δεν ολοκληρώθηκε.");
    } finally { working.current=false; setBusy(false); }
  },[state]);
  const reset = useCallback(() => {
    if (working.current) return;
    cancelSpeech();
    version.current++;
    setState({step:0});
    setNotice(state.step>=2 ? "Τα στοιχεία της πρόβας παραμένουν στον server. Χρειάζεται επαναφορά από τον χειριστή πριν από νέα πρόβα." : "");
  },[state.step]);
  useEffect(()=>{
    const key = (value:string) => {
      if (value==="0") reset();
      if (value==="Enter" || value==="ArrowRight") void next();
    };
    const keyboard = (e:KeyboardEvent) => {
      if (e.repeat || e.ctrlKey || e.altKey || e.metaKey || e.target instanceof HTMLButtonElement && e.key==="Enter") return;
      if (["0","Enter","ArrowRight"].includes(e.key)) { e.preventDefault(); key(e.key); }
    };
    const message = (e:MessageEvent) => { if (e.source === window.parent) key(e.data?.walkthroughKey); };
    window.addEventListener("keydown",keyboard);
    window.addEventListener("message",message);
    return ()=>{window.removeEventListener("keydown",keyboard);window.removeEventListener("message",message);};
  },[next,reset]);
  const known=state.card?.facts.filter(f=>f.value!==null).length ?? 0;
  const total=state.card?.facts.length ?? 0;
  const refresh = useCallback(()=>{
    if(state.step===0 || working.current) return;
    const started = version.current;
    void request<Card>(venuePath).then(card=>{
      if (!working.current && version.current === started) setState(prev=>prev.step ? {...prev,card}:prev);
    }).catch(()=>undefined);
  },[state.step]);
  useEffect(()=>{
    const events=new EventSource("/api/events");
    for (const name of ["venue_requested","map_updated"]) events.addEventListener(name,refresh);
    return ()=>events.close();
  },[refresh]);
  return <main className="ion-walk" lang="el">
    <header><p>ΠΡΟΣΟΜΟΙΩΣΗ ΧΡΗΣΤΩΝ · ΠΡΑΓΜΑΤΙΚΑ ΔΕΔΟΜΕΝΑ ΚΑΙ ΚΑΝΟΝΕΣ</p><h1>Σεράφειο</h1></header>
    <div className="ion-walk-grid">
      <section className="ion-walk-phone" aria-label="Οθόνη κινητού">
        <h2>{labels[state.step-1] ?? "Επίδειξη"}</h2>
        {state.step===1 && <p>Πληκτρολογήθηκε</p>}
        {state.step===3 && !state.requested ? <p>Ερώτηση για τον ανελκυστήρα</p> : <p>{state.step===6 ? state.speech : lines[state.step-1]}</p>}
        {state.step===2 && <p>Ζητήστε να χαρτογραφηθεί · Το αίτημα καταχωρίστηκε</p>}
        {state.step===3 && <p>Απάντηση επίδειξης · Αναμονή δεύτερης μαρτυρίας</p>}
        {state.step===5 && state.route && <><p>{Math.round(state.route.lengthM)} μέτρα</p><div className="ion-walk-map"><CompareMap selected="voice" rows={[{profile:"voice",route:state.route,lengthM:state.route.lengthM,facts:null}]}/></div><small>© OpenStreetMap contributors</small></>}
        {state.step > 0 && <StepIllustration key={state.step} step={state.step} />}
      </section>
      <section aria-label="Καρτέλα προσβασιμότητας">
        <h2>Καρτέλα προσβασιμότητας {total>0 && <span>{known} από {total}</span>}</h2>
        <dl>{state.card?.facts.map(f=><div key={f.key+(f.entranceId??"")}>
          <dt>{f.question}</dt><dd>{f.value===null ? "άγνωστο" : `${f.value==="yes"?"ναι":f.value==="no"?"όχι":f.value} · ${f.source==="openstreetmap"?"ανοιχτός χάρτης":"από δημότες (επίδειξη)"}`}</dd>
        </div>)}</dl>
        <p role="status">{notice || (state.step===2 ? `Αιτήματα χαρτογράφησης: ${state.card?.requestCount}` : state.step===4 ? `${known} από ${total} στοιχεία στην καρτέλα μετά την πρόβα.` : "")}</p>
      </section>
    </div>
    <footer><button className="btn" onClick={reset} disabled={busy}>0 · Επανεκκίνηση</button><button className="btn btn--primary" data-on="accent" onClick={()=>void next()} disabled={busy||state.step===6}>{busy ? "Αναμονή" : "Enter · Επόμενο"}</button></footer>
  </main>;
}

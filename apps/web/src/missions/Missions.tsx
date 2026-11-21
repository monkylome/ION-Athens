import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { LngLat } from "@ion/core";
import { AthensMap } from "../map/AthensMap";
import { request } from "../api/client";
import "./missions.css";

interface Mission { id: string; position: LngLat; question: string; where?: string; points: number; distanceM: number; answers: { yes: number; no: number } }
interface Board { summary: { open: number; confirmed: number }; missions: Mission[] }
interface Profile { points: number; level: string; nextLevel: { name: string; pointsNeeded: number } | null }
interface Rewards { note: string; points: number; rewards: { id: string; title: string; unlocked: boolean; pointsRequired: number }[] }
type Answer = "yes" | "no" | "unsure";
const centralAthens: LngLat = [23.7275, 37.9775];

function participantId() {
  const key = "ion-participant";
  const previous = localStorage.getItem(key);
  if (previous) return previous;
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join("");
  localStorage.setItem(key, id);
  return id;
}

export function Missions() {
  const [point, setPoint] = useState<LngLat>();
  const [demo, setDemo] = useState(false);
  const [board, setBoard] = useState<Board>();
  const [skip, setSkip] = useState<string[]>([]);
  const [refresh, setRefresh] = useState(0);
  const [notice, setNotice] = useState("");
  const [locationState, setLocationState] = useState("Αναζήτηση θέσης…");
  const [profile, setProfile] = useState<Profile>();
  const [busy, setBusy] = useState(false);
  const [showRewards, setShowRewards] = useState(false);
  const [rewards, setRewards] = useState<Rewards>();
  const origin = demo ? (point ?? centralAthens) : point;
  const nearest = board?.missions.find(m => !skip.includes(m.id));
  const position = demo ? nearest?.position : point;

  useEffect(() => {
    const unavailable = () => { setPoint(undefined); setLocationState("Η θέση δεν είναι διαθέσιμη. Επίτρεψε την τοποθεσία ή επίλεξε θέση επίδειξης."); };
    if (!navigator.geolocation) { unavailable(); return; }
    const id = navigator.geolocation.watchPosition(
      p => { setPoint([p.coords.longitude, p.coords.latitude]); setLocationState("Η θέση ενημερώθηκε."); },
      unavailable, { enableHighAccuracy: true });
    return () => navigator.geolocation.clearWatch(id);
  }, []);
  useEffect(() => {
    const stream = new EventSource("/api/events");
    const update = () => setRefresh(n => n + 1);
    for (const event of ["open", "mission_answered", "map_updated"]) stream.addEventListener(event, update);
    return () => stream.close();
  }, []);
  useEffect(() => {
    let current = true;
    if (origin) {
      request<Board>(`/missions?lng=${origin[0]}&lat=${origin[1]}&radius=${demo ? 5000 : 1000}&limit=100`)
        .then(data => { if (current) setBoard(data); })
        .catch(() => { if (current) { setBoard(undefined); setNotice("Αδυναμία φόρτωσης αποστολών."); } });
    } else setBoard(undefined);
    return () => { current = false; };
  }, [origin, demo, refresh]);
  useEffect(() => {
    if (!showRewards) return;
    let current = true;
    async function load() {
      try {
        const data = await request<Rewards>(`/rewards?participant=${participantId()}`);
        if (current) setRewards(data);
      } catch { if (current) setNotice("Αδυναμία φόρτωσης προνομίων."); }
    }
    void load();
    return () => { current = false; };
  }, [showRewards, profile]);

  async function answer(value: Answer) {
    if (!nearest || !position || busy) return;
    setBusy(true);
    try {
      const result = await request<{ pointsEarned: number; confirmed: unknown; profile: Profile }>(
        `${demo ? "/demo" : ""}/missions/${encodeURIComponent(nearest.id)}/answer`,
        { participant: participantId(), answer: value, ...(demo ? {} : { lng: position[0], lat: position[1] }) });
      setNotice(`Κέρδισες ${result.pointsEarned} πόντους. ${result.confirmed ? "Επιβεβαιώθηκε και ενημερώθηκε ο χάρτης." : "Η απάντηση καταγράφηκε, εκκρεμεί επιβεβαίωση."}`);
      setProfile(result.profile);
      setSkip(ids => [...ids, nearest.id]);
      setRefresh(n => n + 1);
    } catch (error) {
      setNotice(error instanceof Error && /[Α-ω]/.test(error.message) ? error.message : "Αδυναμία καταχώρισης της απάντησης.");
    } finally { setBusy(false); }
  }
  return <main className="page missions" data-surface="phone">
    <Link className="btn page__back" to="/">Αρχική</Link><h1>Αποστολές πολιτών</h1>
    <Link className="btn" to="/missions/help">Βοηθήστε ζωντανά με την κάμερα</Link>
    <label><input type="checkbox" checked={demo} disabled={busy} onChange={e => { setDemo(e.target.checked); setBoard(undefined); }} /> Θέση επίδειξης στην κοντινότερη αποστολή</label>
    <p role="status">{demo ? "Ενεργή θέση επίδειξης" : locationState}</p>
    <AthensMap missions={board?.missions} walker={position} center={position ?? origin} />
    <section aria-live="polite" aria-atomic="true">
      {board && <p>{board.summary.open} ανοιχτές αποστολές, {board.summary.confirmed} επιβεβαιώσεις.</p>}
      {nearest ? <><h2>{nearest.question}</h2><p>{nearest.where || "Σημείο στον χάρτη"}, σε {demo ? 0 : nearest.distanceM} μέτρα. {nearest.points} πόντοι.</p>
        <p>Ναι: {nearest.answers.yes}. Όχι: {nearest.answers.no}.</p></> : <p>{board ? "Δεν υπάρχουν άλλες αποστολές κοντά σου." : origin ? "Αναζήτηση αποστολών…" : "Αναμονή θέσης"}</p>}
    </section>
    {nearest && <div className="choices">{([["yes","Ναι"],["no","Όχι"],["unsure","Δεν είμαι σίγουρος"]] as const).map(([value,label]) =>
      <button key={value} className={value === "yes" ? "btn btn--primary" : undefined} data-on={value === "yes" ? "accent" : undefined} disabled={busy || !position} onClick={() => void answer(value)}>{label}</button>)}
      <button disabled={busy} onClick={() => setSkip(ids => [...ids, nearest.id])}>Παράλειψη</button></div>}
    <p role="status">{busy ? "Καταχώριση…" : notice}</p>
    <p aria-live="polite">{profile && `${profile.points} πόντοι, επίπεδο ${profile.level}. ${profile.nextLevel ? `Σε ${profile.nextLevel.pointsNeeded} πόντους: ${profile.nextLevel.name}.` : "Έφτασες στο τελευταίο επίπεδο."}`}</p>
    <button aria-expanded={showRewards} onClick={() => setShowRewards(!showRewards)}>Προνόμια Κάρτας Αθηναίου</button>
    {showRewards && <section aria-live="polite"><h2>Προνόμια</h2>{rewards ? <><p>{rewards.note}</p><ul>{rewards.rewards.map(r =>
      <li key={r.id}>{r.title}: {r.unlocked ? "Διαθέσιμο" : `Χρειάζεσαι ακόμη ${r.pointsRequired - rewards.points} πόντους`}</li>)}</ul></> : <p>Φόρτωση προνομίων…</p>}</section>}
  </main>;
}

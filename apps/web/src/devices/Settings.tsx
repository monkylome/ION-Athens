import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import { BluetoothOutput, uartService, uartRx, type State } from "./bluetooth";
import { labels, phone, Simulation, type Signal } from "./signals";

const states: Record<State, string> = {
  idle: "Χωρίς σύνδεση", connecting: "Σύνδεση…", ready: "Συνδέθηκε", cancelled: "Ακυρώθηκε",
  unsupported: "Το Bluetooth δεν υποστηρίζεται στον browser.", disconnected: "Η συσκευή αποσυνδέθηκε",
  failed: "Αποτυχία σύνδεσης. Έλεγξε τη συσκευή και τα UUID.",
};
export function DeviceSettings() {
  const [mode, setMode] = useState("phone");
  const [state, setState] = useState<State>("idle");
  const [ble] = useState(() => new BluetoothOutput(setState));
  const [service, setService] = useState(uartService);
  const [rx, setRx] = useState(uartRx);
  const [last, setLast] = useState("");
  const [sim] = useState(() => new Simulation((value, at) => setLast(labels[value] + " · " + at.toLocaleTimeString("el-GR"))));
  const [proposed, setProposed] = useState(false);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => () => ble.disconnect(), [ble]);
  useEffect(() => sim.subscribe(() => { setProposed(true); setNotice("Εντοπίστηκε πιθανό εμπόδιο."); }), [sim]);
  async function report() {
    setSending(true);
    try {
      const p = await new Promise<GeolocationPosition>((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 10000 }));
      await api.report({ lng: p.coords.longitude, lat: p.coords.latitude, category: "sidewalk", text: "Επιβεβαιωμένο εμπόδιο κοντά στον πεζό." });
      setProposed(false);
      setNotice("Η αναφορά καταχωρίστηκε.");
    } catch { setNotice("Αδυναμία υποβολής. Έλεγξε την πρόσβαση στη θέση και τη σύνδεση."); }
    finally { setSending(false); }
  }
  const available = mode === "phone" ? typeof navigator.vibrate === "function" : mode === "sim" || state === "ready";
  return <main><Link to="/phone">Τηλέφωνο</Link><h1>Σήματα συσκευής</h1>
    <label>Έξοδος <select value={mode} disabled={sending} onChange={e => {
      ble.disconnect(); setState("idle"); setMode(e.target.value); setNotice(""); setProposed(false);
    }}><option value="phone">Δόνηση τηλεφώνου</option><option value="ble">Bluetooth</option><option value="sim">Προσομοίωση</option></select></label>
    {mode === "ble" && <fieldset><legend>Σύνδεση Bluetooth</legend>
      <label>Service UUID <input value={service} onChange={e => setService(e.target.value)} /></label>
      <label>Characteristic UUID <input value={rx} onChange={e => setRx(e.target.value)} /></label>
      <button disabled={state === "connecting"} onClick={() => void ble.connect(service.trim(), rx.trim())}>Σύνδεση</button>
      <p role="status">{states[state]}</p></fieldset>}
    {mode === "phone" && <p role="status">{available ? "Η δόνηση είναι διαθέσιμη." : "Η δόνηση δεν υποστηρίζεται στον browser."}</p>}
    <fieldset><legend>Δοκιμή σήματος</legend>{(Object.keys(labels) as Signal[]).map(value =>
      <button key={value} disabled={!available} onClick={async () => {
        const device = mode === "phone" ? phone : mode === "ble" ? ble : sim;
        setNotice(await device.signal(value) ? labels[value] : "Το σήμα δεν στάλθηκε.");
      }}>{labels[value]}</button>)}</fieldset>
    {mode === "sim" && <section><h2>ΠΡΟΣΟΜΟΙΩΣΗ ΣΥΣΚΕΥΗΣ</h2><p role="status">{last || "Αναμονή σήματος"}</p>
      <button disabled={proposed} onClick={() => sim.detectNearbyObject()}>Προσομοίωση κοντινού αντικειμένου</button>
      {proposed && <fieldset><legend>Υπάρχει πραγματικό εμπόδιο στη σημερινή σου θέση;</legend>
        <button disabled={sending} onClick={() => void report()}>Επιβεβαίωση και αποστολή με τη θέση μου</button>
        <button disabled={sending} onClick={() => { setProposed(false); setNotice("Η πρόταση απορρίφθηκε."); }}>Απόρριψη</button></fieldset>}</section>}
    <p role="status">{notice}</p>
  </main>;
}

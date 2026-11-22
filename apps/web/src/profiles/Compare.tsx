import { useEffect, useMemo, useRef, useState } from "react";
import { bearingDeg, PROFILES, type LngLat, type ProfileId } from "@ion/core";
import { Map as LibreMap, type GeoJSONSource } from "maplibre-gl";
import { request } from "../api/client";
import { addNetwork, blankStyle, frame, line, tokenColors } from "../map/base";
import { loadGraph } from "../scenario/browser";
import { caption, comparisonPair, updateQuiet, type Compared } from "./comparison";

const ids: ProfileId[] = ["voice", "wheels", "quiet"];
const patterns = [[5, 2], [1, 2], [8, 2, 1, 2]];

export function CompareMap({ rows, selected }: { rows: Compared[]; selected: ProfileId }) {
  const element = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<LibreMap>();
  const [error, setError] = useState(false);
  useEffect(() => {
    const container = element.current!;
    const colors = tokenColors(container);
    const instance = new LibreMap({ container, style: blankStyle(colors), attributionControl: false, interactive: false });
    let active = true;
    instance.once("load", async () => {
      try {
        const { graph } = await loadGraph();
        if (!active) return;
        addNetwork(instance, graph, colors);
        for (const [i, id] of ids.entries()) {
          instance.addSource(id, { type: "geojson", data: line([]) });
          instance.addLayer({ id, type: "line", source: id,
            paint: { "line-color": colors.fg, "line-width": 5, "line-offset": (i - 1) * 10, "line-dasharray": patterns[i]! } });
        }
        instance.addSource("active", { type: "geojson", data: line([]) });
        instance.addLayer({ id: "active", type: "line", source: "active", paint: { "line-color": colors.accent, "line-width": 13 } });
        instance.addLayer({ id: "dots", type: "line", source: "active", layout: { "line-cap": "round" },
          paint: { "line-color": colors.bg, "line-width": 4, "line-dasharray": [0.01, 3] } });
        setMap(instance);
      } catch { if (active) setError(true); }
    });
    return () => { active = false; instance.remove(); };
  }, []);
  useEffect(() => {
    if (!map) return;
    const points: LngLat[] = [];
    for (const r of rows) {
      const coords = r.route?.geometry ?? [];
      map.getSource<GeoJSONSource>(r.profile)?.setData(line(coords));
      points.push(...coords);
    }
    const fit = () => {
      map.resize();
      if (points.length < 2) return;
      const bearing = bearingDeg(points[0]!, points.at(-1)!) - 90;
      const { clientWidth, clientHeight } = map.getContainer();
      const camera = frame(points, bearing, clientWidth, clientHeight, { top: 64, bottom: 64, left: 96, right: 96 }, 20);
      if (camera) map.jumpTo({ ...camera, bearing });
    };
    const observer = new ResizeObserver(fit);
    observer.observe(element.current!);
    fit();
    return () => observer.disconnect();
  }, [map, rows]);
  useEffect(() => {
    if (!map) return;
    const others = ids.filter(id => id !== selected);
    others.forEach((id, i) => map.setPaintProperty(id, "line-offset", i ? 11 : -11));
    for (const id of ids) map.setLayoutProperty(id, "visibility", id === selected ? "none" : "visible");
    map.getSource<GeoJSONSource>("active")?.setData(line(rows.find(r => r.profile === selected)?.route?.geometry ?? []));
  }, [map, rows, selected]);
  return <div className="compare__map" ref={element} role="img" aria-label="Σύγκριση διαδρομών στο δίκτυο πεζών της Αθήνας">{error && "Αδυναμία φόρτωσης χάρτη"}</div>;
}

export function Compare({ query, close }: { query: URLSearchParams; close: () => void }) {
  const headingButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    headingButton.current?.focus({ preventScroll: true });
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  const pair = useMemo(() => comparisonPair(query), [query]);
  const [rows, setRows] = useState<Compared[]>([]);
  const [step, setStep] = useState(0);
  const [error, setError] = useState("");
  const [changed, setChanged] = useState(false);
  useEffect(() => {
    let active = true;
    let version = 0;
    async function load(quietOnly: boolean) {
      const ticket = ++version;
      try {
        const data = await request<{ routes: Compared[] }>("/routes", pair);
        if (!active || ticket !== version) return;
        setRows(prev => quietOnly && prev.length ? updateQuiet(prev, data.routes) : data.routes);
        setError("");
        if (quietOnly) { setChanged(true); setStep(2); }
      } catch { if (active && ticket === version) setError("Η σύγκριση δεν φορτώθηκε."); }
    }
    void load(false);
    const stream = new EventSource("/api/events");
    stream.addEventListener("map_updated", (event: MessageEvent<string>) => {
      try { if (JSON.parse(event.data).observation?.type === "crowd_check") void load(true); } catch { /* Ignore malformed events. */ }
    });
    return () => { active = false; stream.close(); };
  }, [pair]);
  const ready = rows.length > 0;
  useEffect(() => {
    if (!ready || step >= ids.length || changed) return;
    const timer = window.setTimeout(() => setStep(s => s + 1), 5200);
    return () => window.clearTimeout(timer);
  }, [step, ready, changed]);
  const selected = ids[step] ?? "quiet";
  const row = rows.find(r => r.profile === selected);
  return <section className="compare" role="dialog" aria-modal="true" aria-label="Σύγκριση διαδρομών">
    <header>{ids.map(id => <button key={id} ref={id === "voice" ? headingButton : undefined} data-pattern={id} aria-pressed={id === selected} onClick={() => { setChanged(false); setStep(ids.indexOf(id)); }}>{PROFILES[id].label}</button>)}
      <button className="compare__close" onClick={close}>Έξοδος</button></header>
    <div className="compare__frame"><CompareMap rows={rows} selected={selected} /></div>
    <footer aria-live="polite"><h1>{step >= ids.length ? "Η ίδια πόλη. Η διαδρομή του καθενός." : PROFILES[selected].label}</h1>
      <p>{error || (step < ids.length ? row ? caption(row) : "Αναζήτηση διαδρομών…" : "")}</p>
      {changed && <p>Ενημέρωση από επιβεβαίωση δημοτών.</p>}</footer>
  </section>;
}

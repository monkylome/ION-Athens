import { useEffect, useMemo, useRef, useState } from "react";
import { Map as MapLibreMap, type GeoJSONSource } from "maplibre-gl";
import { bearingDeg, polylineLengthM, slicePolyline, type LngLat } from "@ion/core";
import "maplibre-gl/dist/maplibre-gl.css";
import { addBuildings, addNetwork, blankStyle, frame, line, tokenColors } from "../map/base";
import { MapMarker } from "../map/MapMarker";
import { loadGraph } from "../scenario/browser";
import type { ScenarioState, TrackedObstacle } from "../scenario/types";

const DRAW_MS = 700; // --dur-draw
const CAMERA_MS = 1200; // --dur-camera

function setLine(map: MapLibreMap, id: string, coordinates: readonly LngLat[]) {
  map.getSource<GeoJSONSource>(id)?.setData(line(coordinates));
}

/** The words on an obstacle: what it is, how many people have seen it, and that it is not a real incident. */
export function obstacleWords(t: TrackedObstacle): { title: string; count: string | null; stamp: string } {
  const count = t.report ? `${Math.min(t.witnesses, t.needed)} από ${t.needed}` : null;
  const title = t.report ? (t.closes ? "Εμπόδιο" : "Αναφορά") : "Έργα";
  const stamp = t.local ? "Τοπικό, για το demo" : t.createdHere ? "Για το demo" : "Δοκιμαστικό";
  return { title, count, stamp };
}

export function StageMap({ state, reducedMotion, tiles }: { state: ScenarioState; reducedMotion: boolean; tiles: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<MapLibreMap | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const { route, change, moment, walker, start, destination } = state;
  const beat = moment?.beat ?? null;

  useEffect(() => {
    const element = container.current!;
    const colors = tokenColors(element);
    const instance = new MapLibreMap({
      container: element,
      style: blankStyle(colors),
      center: [23.7275, 37.9775],
      zoom: 15.5,
      attributionControl: false,
      interactive: false,
      fadeDuration: 0,
    });
    let disposed = false;
    instance.once("load", () => {
      void loadGraph().then(({ graph }) => {
        if (disposed) return;
        addNetwork(instance, graph, colors);
        if (tiles) addBuildings(instance, colors);
        const unit = element.clientWidth / 100; // route widths follow the projector, like the type
        for (const id of ["ion-old", "ion-route"]) instance.addSource(id, { type: "geojson", data: line([]) });
        // The abandoned way: dimmed and dashed, cut with a hard edge.
        instance.addLayer({
          id: "ion-old", type: "line", source: "ion-old",
          layout: { "line-cap": "butt", "line-join": "bevel" },
          paint: { "line-color": colors.accentDim, "line-width": unit * 0.9, "line-dasharray": [1.6, 1.3] },
        });
        // The route as a tactile strip: a yellow band with a row of black dots down its centre.
        instance.addLayer({
          id: "ion-route", type: "line", source: "ion-route",
          layout: { "line-cap": "butt", "line-join": "bevel" },
          paint: { "line-color": colors.accent, "line-width": unit * 1.5 },
        });
        instance.addLayer({
          id: "ion-route-dots", type: "line", source: "ion-route",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": colors.bg, "line-width": unit * 0.42, "line-dasharray": [0.01, 3.2] },
        });
        setMap(instance);
      });
    });
    const observer = new ResizeObserver(() => {
      instance.resize();
      setSize({ width: element.clientWidth, height: element.clientHeight });
    });
    observer.observe(element);
    return () => {
      disposed = true;
      observer.disconnect();
      instance.remove();
      setMap(null);
    };
  }, [tiles]);

  // The whole scene is turned so that the walk runs from left to right across the stage.
  const bearing = useMemo(() => {
    const from: LngLat | null = route?.geometry[0] ?? (start ? [start.lng, start.lat] : null);
    const to: LngLat | null = route?.geometry.at(-1) ?? (destination ? [destination.lng, destination.lat] : null);
    return from && to ? bearingDeg(from, to) - 90 : 0;
    // The turn is fixed for a walk: a reroute must not spin the map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start?.lng, start?.lat, destination?.lng, destination?.lat, route === null]);

  // Lines. During the warning and the dark, the new part is not drawn yet; then it grows from the old route.
  const hold = change !== null && (beat === "warn" || beat === "dark");
  useEffect(() => {
    if (!map) return;
    if (!route) {
      setLine(map, "ion-route", []);
      setLine(map, "ion-old", []);
      return;
    }
    setLine(map, "ion-old", change ? change.abandoned : []);
    if (!change) {
      setLine(map, "ion-route", route.geometry);
      return;
    }
    const kept = change.divergeAtM > 0 ? slicePolyline(route.geometry, 0, change.divergeAtM) : [];
    if (hold) {
      setLine(map, "ion-route", kept);
      return;
    }
    if (reducedMotion) {
      setLine(map, "ion-route", route.geometry);
      return;
    }
    const total = polylineLengthM(change.fresh);
    const began = performance.now();
    let raf = 0;
    const draw = () => {
      const t = Math.min(1, (performance.now() - began) / DRAW_MS);
      setLine(map, "ion-route", t >= 1 ? route.geometry : [...kept, ...slicePolyline(change.fresh, 0, total * t)]);
      if (t < 1) raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
    // Redraw when the route, the change or the hold changes, not on every walker tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, route, change?.id, hold, reducedMotion]);

  // Camera: still while walking. It moves when the scene changes, after the voice has spoken.
  const framed = useRef(false);
  const metricsShown = state.metrics !== null && state.phase !== "rerouting";
  const frameKey = `${metricsShown}|${route ? route.edges.length + ":" + Math.round(route.lengthM) : "none"}|${hold ? "hold" : (change?.id ?? 0)}|${destination?.name ?? ""}|${start?.name ?? ""}|${size.width}x${size.height}|${bearing.toFixed(1)}`;
  useEffect(() => {
    if (!map || hold || size.width === 0) return;
    const points: LngLat[] = [];
    if (route) points.push(...route.geometry);
    if (change) points.push(...change.abandoned);
    if (!route) {
      if (start) points.push([start.lng, start.lat]);
      if (destination) points.push([destination.lng, destination.lat]);
    }
    const unit = size.width / 100;
    // Room for the labels above and below the line, and for the measurements once they are shown.
    const padding = { top: unit * 8, right: unit * (metricsShown ? 33 : 8), bottom: unit * 7.5, left: unit * 7 };
    const target = frame(points, bearing, size.width, size.height, padding, points.length < 2 ? 16.6 : 18.2);
    if (!target) return;
    const camera = { center: target.center, zoom: target.zoom, bearing, padding };
    if (!framed.current || reducedMotion) map.jumpTo(camera);
    else map.easeTo({ ...camera, duration: CAMERA_MS, easing: (t) => 1 - Math.pow(1 - t, 3) });
    framed.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, frameKey, reducedMotion]);

  const shown = state.obstacles.filter(
    (t) => t.obstacle.position && (t.report || t.obstacle.id === state.focusObstacleId || t.obstacle.id === change?.obstacleId),
  );

  return (
    <div className="stage-canvas" ref={container} role="img" aria-label="Χάρτης κεντρικής Αθήνας με τη διαδρομή. Η διαδρομή δίνεται και ως λίστα βημάτων.">
      {map && start && (
        <MapMarker map={map} at={route?.geometry[0] ?? [start.lng, start.lat]} anchor="top-left" className="pin-wrap">
          {/* Once the walk begins the walker marks the place; the name would only cover the first steps. */}
          <span className="place-pin" data-bare={route !== null}><span className="place-pin__mark" aria-hidden="true" />{route ? null : start.name}</span>
        </MapMarker>
      )}
      {map && state.crossingNotice && state.loop && (
        <MapMarker map={map} at={state.loop.crossing.position} anchor="bottom">
          <span className="crossing-notice" aria-label={state.crossingNotice}>♪</span>
        </MapMarker>
      )}
      {map && destination && (
        <MapMarker map={map} at={route?.geometry.at(-1) ?? [destination.lng, destination.lat]} anchor="top-right" className="pin-wrap">
          <span className="place-pin place-pin--end"><span className="place-pin__mark" aria-hidden="true" />{destination.name}</span>
        </MapMarker>
      )}
      {map && shown.map((t) => {
        const words = obstacleWords(t);
        return (
          <MapMarker key={t.obstacle.id} map={map} at={t.obstacle.position!} anchor="bottom" className="obstacle-wrap">
            <span className="obstacle" data-closes={t.closes} data-fresh={beat === "warn" && t.obstacle.id === change?.obstacleId}>
              <span className="obstacle__label">
                <span className="obstacle__title">{words.title}</span>
                {words.count && <span className="obstacle__count">{words.count}</span>}
                <span className="obstacle__stamp">{words.stamp}</span>
              </span>
              <span className="obstacle__ring" aria-hidden="true"><span className="obstacle__sign">!</span></span>
            </span>
          </MapMarker>
        );
      })}
      {map && walker && (
        <MapMarker map={map} at={walker.position} className="walker-wrap">
          <span className="walker" role="img" aria-label="Θέση περιπατητή, προσομοίωση" />
        </MapMarker>
      )}
    </div>
  );
}

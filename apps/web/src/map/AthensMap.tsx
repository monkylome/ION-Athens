import type * as GeoJSON from "geojson";
import { useEffect, useRef, useState } from "react";
import { Map, Marker, type GeoJSONSource } from "maplibre-gl";
import type { LngLat, Obstacle, Route } from "@ion/core";
import "maplibre-gl/dist/maplibre-gl.css";
import { addBuildings, addNetwork, blankStyle, tokenColors } from "./base";
import { loadGraph } from "../scenario/browser";

export function drawRoute(map: Map, route?: Route) {
  const features: GeoJSON.Feature<GeoJSON.LineString>[] = route && route.geometry.length > 1
    ? [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: route.geometry } }]
    : [];
  const data: GeoJSON.FeatureCollection<GeoJSON.LineString> = { type: "FeatureCollection", features };
  const source = map.getSource<GeoJSONSource>("ion-route");
  if (source) return source.setData(data);
  map.addSource("ion-route", { type: "geojson", data });
  const color = getComputedStyle(map.getContainer()).getPropertyValue("--accent").trim();
  map.addLayer({ id: "ion-route", type: "line", source: "ion-route", layout: { "line-cap": "butt", "line-join": "miter" }, paint: { "line-color": color, "line-width": 8 } });
}

function marker(map: Map, point: LngLat, className: string, label: string) {
  const element = document.createElement("span");
  element.className = className;
  element.setAttribute("role", "img");
  element.setAttribute("aria-label", label);
  return new Marker({ element }).setLngLat(point).addTo(map);
}
export function drawObstacles(map: Map, obstacles: readonly Obstacle[]) {
  return obstacles.flatMap(o => o.position ? [marker(map, o.position, "obstacle-dot", o.label)] : []);
}
export function moveWalker(map: Map, point: LngLat, previous?: Marker) {
  return previous ? previous.setLngLat(point) : marker(map, point, "walker-dot", "Θέση πεζού");
}

export function AthensMap({ route, obstacles, walker, missions, center }: { missions?: {position: LngLat; question: string}[]; center?: LngLat; route?: Route; obstacles?: Obstacle[]; walker?: LngLat }) {
  const container = useRef<HTMLDivElement>(null);
  const walkerMarker = useRef<Marker | undefined>(undefined);
  const [map, setMap] = useState<Map>();
  useEffect(() => {
    const colors = tokenColors(container.current!);
    // The ION basemap: token colours, and the pedestrian graph as its streets, served from this machine.
    const instance = new Map({ container: container.current!, style: blankStyle(colors), center: [23.7275, 37.9775], zoom: 15, attributionControl: false, fadeDuration: 0 });
    // No credit on the map itself: the attribution is on the About page, one interaction away.
    let disposed = false;
    instance.once("load", () => {
      setMap(instance);
      void loadGraph().then(({ graph }) => {
        if (disposed) return;
        addNetwork(instance, graph, colors);
        addBuildings(instance, colors);
        // Streets go under the route, whichever was drawn first.
        if (instance.getLayer("ion-route")) instance.moveLayer("ion-route");
      }, () => undefined);
    });
    return () => { disposed = true; walkerMarker.current?.remove(); instance.remove(); };
  }, []);
  useEffect(() => { if (map) drawRoute(map, route); }, [map, route]);
  useEffect(() => {
    if (!map) return;
    const markers = drawObstacles(map, obstacles ?? []);
    return () => markers.forEach(m => m.remove());
  }, [map, obstacles]);
  useEffect(() => {
    if (map && walker) walkerMarker.current = moveWalker(map, walker, walkerMarker.current);
    else { walkerMarker.current?.remove(); walkerMarker.current = undefined; }
  }, [map, walker]);
  useEffect(() => {
    if (map && center) map.jumpTo({ center });
  }, [map, center]);
  useEffect(() => {
    if (!map) return;
    const marks = missions?.map(m => marker(map, m.position, "mission-pin", m.question));
    return () => marks?.forEach(m => m.remove());
  }, [map, missions]);
  return <div ref={container} className="map" aria-label="Χάρτης κεντρικής Αθήνας" />;
}

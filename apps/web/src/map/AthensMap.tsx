import type * as GeoJSON from "geojson";
import { useEffect, useRef, useState } from "react";
import { AttributionControl, Map, Marker, type GeoJSONSource } from "maplibre-gl";
import type { LngLat, Obstacle, Route } from "@ion/core";
import "maplibre-gl/dist/maplibre-gl.css";

export const BASEMAP_URL = "https://tiles.openfreemap.org/styles/dark";
export function drawRoute(map: Map, route?: Route) {
  const features: GeoJSON.Feature<GeoJSON.LineString>[] = route && route.geometry.length > 1
    ? [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: route.geometry } }]
    : [];
  const data: GeoJSON.FeatureCollection<GeoJSON.LineString> = { type: "FeatureCollection", features };
  const source = map.getSource<GeoJSONSource>("ion-route");
  if (source) return source.setData(data);
  map.addSource("ion-route", { type: "geojson", data });
  const color = getComputedStyle(map.getContainer()).getPropertyValue("--accent").trim();
  map.addLayer({ id: "ion-route", type: "line", source: "ion-route", paint: { "line-color": color, "line-width": 5 } });
}

function marker(map: Map, point: LngLat, className: string, label: string) {
  const element = document.createElement("span");
  element.className = className;
  element.setAttribute("role", "img");
  element.setAttribute("aria-label", label);
  return new Marker({ element }).setLngLat(point).addTo(map);
}
export function drawObstacles(map: Map, obstacles: readonly Obstacle[]) {
  return obstacles.flatMap(o => o.position ? [marker(map, o.position, "obstacle", o.label)] : []);
}
export function moveWalker(map: Map, point: LngLat, previous?: Marker) {
  return previous ? previous.setLngLat(point) : marker(map, point, "walker", "Θέση πεζού");
}

export function AthensMap({ route, obstacles, walker }: { route?: Route; obstacles?: Obstacle[]; walker?: LngLat }) {
  const container = useRef<HTMLDivElement>(null);
  const walkerMarker = useRef<Marker | undefined>(undefined);
  const [map, setMap] = useState<Map>();
  useEffect(() => {
    const instance = new Map({ container: container.current!, style: BASEMAP_URL, center: [23.7275, 37.9775], zoom: 15, attributionControl: false });
    instance.addControl(new AttributionControl({ compact: false, customAttribution: '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap</a>' }));
    instance.once("load", () => setMap(instance));
    return () => { walkerMarker.current?.remove(); instance.remove(); };
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
  return <div ref={container} className="map" aria-label="Χάρτης κεντρικής Αθήνας" />;
}

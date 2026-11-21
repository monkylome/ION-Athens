/**
 * The ION basemap. Its colours are the design tokens and its streets are the
 * pedestrian graph the routes are computed on, served from this machine: the
 * map works with no network. Building footprints are added from OpenFreeMap
 * tiles when the network allows, and are never required.
 */
import type * as GeoJSON from "geojson";
import type { Map as MapLibreMap, StyleSpecification } from "maplibre-gl";
import type { LngLat, PedestrianGraph } from "@ion/core";

export interface TokenColors {
  bg: string;
  fg: string;
  accent: string;
  accentDim: string;
  alert: string;
  road: string;
  building: string;
}

export function tokenColors(element: Element): TokenColors {
  const css = getComputedStyle(element);
  const read = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    bg: read("--bg", "#000000"),
    fg: read("--fg", "#FFFFFF"),
    accent: read("--accent", "#FFD100"),
    accentDim: read("--accent-dim", "#B38F00"),
    alert: read("--alert", "#FF6B35"),
    road: read("--map-road", "#3A3A3A"),
    building: read("--map-building", "#2A2A2A"),
  };
}

export function blankStyle(colors: TokenColors): StyleSpecification {
  return {
    version: 8,
    sources: {},
    layers: [{ id: "ion-bg", type: "background", paint: { "background-color": colors.bg } }],
  };
}

export const NETWORK_LAYER = "ion-network";
export const BUILDING_TILES = "https://tiles.openfreemap.org/planet";

export function line(coordinates: readonly LngLat[]): GeoJSON.FeatureCollection<GeoJSON.LineString> {
  return {
    type: "FeatureCollection",
    features: coordinates.length > 1 ? [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coordinates as LngLat[] } }] : [],
  };
}

/** The pedestrian network as quiet streets. */
export function addNetwork(map: MapLibreMap, graph: PedestrianGraph, colors: TokenColors): void {
  if (map.getSource(NETWORK_LAYER)) return;
  map.addSource(NETWORK_LAYER, {
    type: "geojson",
    data: {
      type: "FeatureCollection",
      features: graph.edges.map((edge) => ({ type: "Feature", properties: { kind: edge.kind }, geometry: { type: "LineString", coordinates: edge.geometry } })),
    },
  });
  map.addLayer({
    id: NETWORK_LAYER,
    type: "line",
    source: NETWORK_LAYER,
    layout: { "line-cap": "butt", "line-join": "miter" },
    paint: {
      "line-color": colors.road,
      "line-width": ["interpolate", ["exponential", 2], ["zoom"], 12, 0.6, 15, 2.5, 17, 9, 19, 30],
    },
  });
}

/** Building footprints from the network, under the streets. Fails silently: the map is complete without them. */
export function addBuildings(map: MapLibreMap, colors: TokenColors): void {
  try {
    if (map.getSource("ion-buildings")) return;
    map.addSource("ion-buildings", { type: "vector", url: BUILDING_TILES });
    map.addLayer(
      {
        id: "ion-buildings",
        type: "fill",
        source: "ion-buildings",
        "source-layer": "building",
        minzoom: 13,
        paint: { "fill-color": colors.building, "fill-antialias": false },
      },
      map.getLayer(NETWORK_LAYER) ? NETWORK_LAYER : undefined,
    );
  } catch {
    /* no tiles: the street network alone is the map */
  }
}

const EARTH_M = 40075016.686;

/**
 * Centre and zoom that put all points inside a viewport turned to `bearing`,
 * leaving `padding` pixels free on each side.
 */
export function frame(
  points: readonly LngLat[],
  bearing: number,
  width: number,
  height: number,
  padding: { top: number; right: number; bottom: number; left: number },
  maxZoom = 18.2,
): { center: LngLat; zoom: number } | null {
  const first = points[0];
  if (!first) return null;
  const rad = Math.PI / 180;
  const cosLat = Math.cos(first[1] * rad);
  const mPerDeg = 111195.08;
  const b = bearing * rad;
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const [lng, lat] of points) {
    const e = (lng - first[0]) * mPerDeg * cosLat;
    const n = (lat - first[1]) * mPerDeg;
    const u = e * Math.cos(b) - n * Math.sin(b);
    const v = e * Math.sin(b) + n * Math.cos(b);
    minU = Math.min(minU, u); maxU = Math.max(maxU, u);
    minV = Math.min(minV, v); maxV = Math.max(maxV, v);
  }
  const uc = (minU + maxU) / 2;
  const vc = (minV + maxV) / 2;
  const e = uc * Math.cos(b) + vc * Math.sin(b);
  const n = -uc * Math.sin(b) + vc * Math.cos(b);
  const usableW = Math.max(50, width - padding.left - padding.right);
  const usableH = Math.max(50, height - padding.top - padding.bottom);
  const metresPerPixel = Math.max((maxU - minU) / usableW, (maxV - minV) / usableH, 0.01);
  const zoom = Math.min(maxZoom, Math.log2((EARTH_M * cosLat) / (512 * metresPerPixel)));
  return { center: [first[0] + e / (mPerDeg * cosLat), first[1] + n / mPerDeg], zoom };
}

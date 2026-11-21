/**
 * The map is the screen: full-bleed, tilted, behind the player, turning with
 * the compass, buildings standing up in the system's greys. MapLibre built-ins
 * only. Missions are objects standing in that city: a head on a stem, with a
 * glyph for what they are. They are ordinary DOM, so a pulse costs no repaint.
 *
 * The board is a picture for people who see it. It is hidden from assistive
 * technology; the same missions are real buttons in the «Κοντά σας» tray.
 */
import { useEffect, useRef, useState } from "react";
import { Map as MapLibreMap, type GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Check, Eye } from "@phosphor-icons/react";
import type { LngLat } from "@ion/core";
import { addNetwork, blankStyle, BUILDING_TILES, NETWORK_LAYER, tokenColors } from "../map/base";
import { MapMarker } from "../map/MapMarker";
import { loadGraph } from "../scenario/browser";
import { distanceM, REACH_M, ring } from "./geo";
import { kindOf, venueProgress, type Discovery, type Nearby, type Place, type Venue } from "./game";
import { Glyph } from "./parts";

/** Beyond this an object is small and hollow; inside it the head grows and shows what it is worth. */
export const OPEN_M = 110;
const ZOOM = 18.1;
const PITCH = 62;
/** The action bar covers this much of the bottom of the screen (px): the player stands above it. */
const HUD_BOTTOM = 84;

const ROAD_RANK: Record<string, number> = { motorway: 0, trunk: 0, primary: 1, secondary: 2, tertiary: 3, minor: 4, service: 6, path: 7, track: 7 };
export interface StreetName { name: string; at: LngLat }

export interface Flash { id: string; at: LngLat; confirmed: boolean }

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function ringData(centre: LngLat | null, radius: number): GeoJSON.FeatureCollection<GeoJSON.LineString> {
  return {
    type: "FeatureCollection",
    features: centre ? [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: ring(centre, radius) } }] : [],
  };
}

export function Board({ centre, player, heading, reach, spots, venues, discoveries, aim, focus, flashes, onTap }: {
  /** Where the camera looks when there is no player yet. */
  centre: LngLat;
  player: LngLat | null;
  heading: number | null;
  /** Radius of the reach ring in metres. */
  reach: number;
  /** One object per place; a place may hold several questions. */
  spots: readonly Place[];
  /** Cards of the places on the board, for how full each one is. */
  venues: Readonly<Record<string, Venue>>;
  /** What the scan mode found: already on the map, shown as found objects. */
  discoveries: readonly Discovery[];
  /** The mission the bottom action points at: its object carries a second frame. */
  aim: Nearby | null;
  /** An encounter: the camera pushes in on this point. */
  focus: LngLat | null;
  flashes: readonly Flash[];
  onTap(spot: Place): void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<MapLibreMap | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = container.current!;
    const colors = tokenColors(element);
    const label = getComputedStyle(element).getPropertyValue("--map-label").trim() || colors.fg;
    const instance = new MapLibreMap({
      container: element,
      style: blankStyle(colors),
      center: centre,
      zoom: ZOOM,
      pitch: PITCH,
      maxPitch: 70,
      attributionControl: false,
      fadeDuration: 0,
      interactive: false, // the board follows the player; nobody drags it away from where they stand
    });
    // No credit on the board: the OpenStreetMap attribution is kept one interaction away, in the menu under «Σχετικά», which its guidelines accept for small screens.
    let disposed = false;
    instance.once("load", () => {
      if (disposed) return;
      instance.addSource("play-reach", { type: "geojson", data: ringData(null, REACH_M) });
      instance.addLayer({ id: "play-reach", type: "line", source: "play-reach", layout: { "line-cap": "butt", "line-join": "miter" }, paint: { "line-color": colors.fg, "line-width": 4, "line-dasharray": [2, 1.5] } });
      // The city itself, everywhere: streets and buildings from OpenFreeMap. The game still works without them.
      try {
        instance.addSource("play-city", { type: "vector", url: BUILDING_TILES });
        instance.addLayer({
          id: "play-streets", type: "line", source: "play-city", "source-layer": "transportation", minzoom: 13,
          layout: { "line-cap": "butt", "line-join": "miter" },
          paint: { "line-color": colors.road, "line-width": ["interpolate", ["exponential", 2], ["zoom"], 13, 1, 16, 6, 18, 22, 20, 80] },
        }, "play-reach");
        // A lighter line down each street a car or a person can name, so the city reads as streets and not as a dark mass.
        instance.addLayer({
          id: "play-street-lines", type: "line", source: "play-city", "source-layer": "transportation", minzoom: 13,
          filter: ["match", ["get", "class"], ["motorway", "trunk", "primary", "secondary", "tertiary", "minor"], true, false],
          layout: { "line-cap": "butt", "line-join": "miter" },
          paint: { "line-color": label, "line-width": ["match", ["get", "class"], ["primary", "secondary", "trunk", "motorway"], 4, 2], "line-dasharray": [6, 3] },
        }, "play-reach");
        instance.addLayer({
          id: "play-buildings", type: "fill-extrusion", source: "play-city", "source-layer": "building", minzoom: 15,
          paint: {
            "fill-extrusion-color": colors.building,
            "fill-extrusion-height": ["coalesce", ["get", "render_height"], 9],
            "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
            "fill-extrusion-vertical-gradient": false,
          },
        }, "play-reach");
      } catch { /* no tiles */ }
      setMap(instance);
      // The pedestrian graph the routes are computed on, where it is mapped.
      void loadGraph().then(({ graph }) => {
        if (disposed) return;
        addNetwork(instance, graph, colors);
        instance.moveLayer(NETWORK_LAYER, instance.getLayer("play-buildings") ? "play-buildings" : "play-reach");
      }, () => undefined);
    });
    // A failed tile is not an error worth a console full of red on stage.
    instance.on("error", () => undefined);
    const observer = new ResizeObserver(() => {
      instance.resize();
      const box = frame.current?.getBoundingClientRect();
      if (box) setSize({ width: box.width, height: box.height });
    });
    observer.observe(frame.current!);
    return () => { disposed = true; observer.disconnect(); instance.remove(); setMap(null); };
    // The map is made once; the camera effect below keeps it on the player.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const at = player ?? centre;
  useEffect(() => {
    if (!map) return;
    // An encounter pushes in on the object; otherwise the camera sits behind the player,
    // who stands below the middle so that more of the street ahead is on the board.
    const below = Math.round((size.height - HUD_BOTTOM) * 0.8 - size.height / 2); // the player in the lower third, clear of the action bar
    const camera = focus
      ? { center: focus, bearing: heading ?? 0, pitch: PITCH, zoom: ZOOM + 1, offset: [0, 0] as [number, number] }
      : { center: at, bearing: heading ?? 0, pitch: PITCH, zoom: ZOOM, offset: [0, Math.max(0, below)] as [number, number] };
    if (reducedMotion()) map.jumpTo(camera);
    else map.easeTo({ ...camera, duration: focus ? 420 : 350, easing: (t) => t });
  }, [map, at[0], at[1], heading, size.height, focus?.[0], focus?.[1]]); // eslint-disable-line react-hooks/exhaustive-deps

  // An object that is partly on screen is pushed fully onto it: a landmark is never cut by the edge.
  useEffect(() => {
    if (!map) return;
    const clamp = () => {
      const box = frame.current?.getBoundingClientRect();
      if (!box) return;
      frame.current!.querySelectorAll<HTMLElement>(".ob--near, .ob--reach").forEach((el) => {
        el.style.transform = "";
        const r = el.getBoundingClientRect();
        const dx = r.left < box.left + 4 ? box.left + 4 - r.left : r.right > box.right - 4 ? box.right - 4 - r.right : 0;
        if (dx !== 0 && Math.abs(dx) < r.width) el.style.transform = `translateX(${Math.round(dx)}px)`;
      });
    };
    map.on("move", clamp);
    clamp();
    return () => { map.off("move", clamp); };
  }, [map, spots]);

  useEffect(() => {
    map?.getSource<GeoJSONSource>("play-reach")?.setData(ringData(player, reach));
  }, [map, player?.[0], player?.[1], reach]); // eslint-disable-line react-hooks/exhaustive-deps

  // The names of the streets around the player, as plates in the system's type. Read from the tiles on the
  // board, so they are there wherever the player is. A few, the main ones first, never on top of the player.
  const [streets, setStreets] = useState<StreetName[]>([]);
  const playerRef = useRef(at);
  playerRef.current = at;
  useEffect(() => {
    if (!map) return;
    const update = () => {
      let features: ReturnType<MapLibreMap["querySourceFeatures"]> = [];
      try { features = map.querySourceFeatures("play-city", { sourceLayer: "transportation_name" }); } catch { return; }
      const here = playerRef.current;
      const best = new Map<string, { rank: number; far: number; at: LngLat }>();
      for (const f of features) {
        const name = (f.properties?.["name"] ?? f.properties?.["name:latin"]) as string | undefined;
        if (!name || (f.geometry.type !== "LineString" && f.geometry.type !== "MultiLineString")) continue;
        const rank = ROAD_RANK[String(f.properties?.["class"])] ?? 5;
        const lines = f.geometry.type === "LineString" ? [f.geometry.coordinates] : f.geometry.coordinates;
        for (const line of lines) for (const c of line) {
          const far = distanceM(here, [c[0]!, c[1]!]);
          if (far < 35 || far > 190) continue;
          const had = best.get(name);
          if (!had || far < had.far) best.set(name, { rank, far, at: [c[0]!, c[1]!] });
        }
      }
      const picked = [...best].sort((a, b) => a[1].rank - b[1].rank || a[1].far - b[1].far).slice(0, 5).map(([name, v]) => ({ name, at: v.at }));
      setStreets((old) => (old.map((o) => o.name + o.at.join()).join("|") === picked.map((o) => o.name + o.at.join()).join("|") ? old : picked));
    };
    map.on("idle", update);
    return () => { map.off("idle", update); };
  }, [map]);

  return (
    <div ref={frame} className="pl-board" aria-hidden="true">
      <div ref={container} className="pl-board__map" />
      {map && spots.map((spot) => {
        const mission = spot.first.mission;
        const place = kindOf(mission) === "place";
        const state = spot.open === 0 ? "done" : spot.reachable ? "reach" : spot.distance <= OPEN_M ? "near" : "far";
        const venue = mission.venueId ? venues[mission.venueId] : undefined;
        const fill = venue ? venueProgress(venue) : null;
        const aimed = aim !== null && spot.items.some((n) => n.mission.id === aim.mission.id);
        return (
          <MapMarker key={spot.key} map={map} at={spot.at} anchor="bottom" className={`ob-host ob-host--${state}`}>
            <button type="button" tabIndex={-1} className={`ob ob--${state}${place ? " ob--place" : ""}${aimed ? " ob--aim" : ""}`} onClick={() => onTap(spot)}>
              {place && state !== "far" && mission.where && <span className="ob__name">{mission.where.split(",")[0]}</span>}
              <span className="ob__head">
                {state === "done" ? <Check weight="bold" className="ob__glyph" /> : <Glyph mission={mission} className="ob__glyph" />}
                {place && fill ? <span className="ob__text">{fill.known}/{fill.total}</span>
                  : state === "near" || state === "reach" ? <span className="ob__text">+{mission.points}</span> : null}
                {!place && spot.open > 1 && state !== "far" && <span className="ob__count">×{spot.open}</span>}
              </span>
              {place && fill && state !== "far" && (
                <span className="ob__cells">{Array.from({ length: fill.total }, (_, i) => <span key={i} className={i < fill.known ? "ob__cell ob__cell--full" : "ob__cell"} />)}</span>
              )}
              <span className="ob__stem" />
              <span className="ob__foot" />
            </button>
          </MapMarker>
        );
      })}
      {map && discoveries.map((d) => (
        <MapMarker key={d.id} map={map} at={d.at} anchor="bottom" className="ob-host ob-host--near">
          <span className="ob ob--found" data-confirmed={d.confirmed}><span className="ob__name">{d.label} · {d.confirmed ? "Επιβεβαιώθηκε" : "Μία μαρτυρία"}</span><span className="ob__head"><Eye weight="fill" className="ob__glyph" /></span><span className="ob__stem" /><span className="ob__foot" /></span>
        </MapMarker>
      ))}
      {map && streets.map((street) => (
        <MapMarker key={street.name} map={map} at={street.at} className="ob-host ob-host--street"><span className="pl-street">{street.name}</span></MapMarker>
      ))}
      {map && flashes.map((f) => (
        <MapMarker key={f.id} map={map} at={f.at} anchor="bottom" className="ob-host ob-host--flash">
          <span className={`pl-flash${f.confirmed ? " pl-flash--confirmed" : ""}`}><Check weight="bold" className="ob__glyph" /></span>
        </MapMarker>
      ))}
      {map && player && (
        <MapMarker map={map} at={player} className="ob-host ob-host--player">
          <span className={`pl-player${heading === null ? " pl-player--still" : ""}`}>
            {heading !== null && <span className="pl-player__cone" />}
            <span className="pl-player__mark"><span className="pl-player__ring"><span className="pl-player__core" /></span></span>
          </span>
        </MapMarker>
      )}
    </div>
  );
}

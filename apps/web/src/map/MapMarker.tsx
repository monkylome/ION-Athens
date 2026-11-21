import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Marker, type Map as MapLibreMap, type PositionAnchor } from "maplibre-gl";
import type { LngLat } from "@ion/core";

/** A map marker whose content is ordinary React: live text, never an image. */
export function MapMarker({ map, at, anchor = "center", className, children }: { map: MapLibreMap; at: LngLat; anchor?: PositionAnchor; className?: string; children: ReactNode }) {
  const [host, setHost] = useState<{ marker: Marker; element: HTMLDivElement } | null>(null);
  useEffect(() => {
    const element = document.createElement("div");
    const marker = new Marker({ element, anchor }).setLngLat(at).addTo(map);
    setHost({ marker, element });
    return () => {
      marker.remove();
      setHost(null);
    };
    // The position is kept current below; the marker itself is made once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, anchor]);
  useEffect(() => {
    host?.marker.setLngLat(at);
  }, [host, at[0], at[1]]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // MapLibre owns the element's class list; add ours without replacing its own.
    if (!host || !className) return;
    const names = className.split(" ").filter(Boolean);
    host.element.classList.add(...names);
    return () => host.element.classList.remove(...names);
  }, [host, className]);
  return host ? createPortal(children, host.element) : null;
}

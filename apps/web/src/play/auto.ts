import { useEffect, useRef } from "react";
import type { LngLat, Route } from "@ion/core";
import { request } from "../api/client";
import type { Nearby } from "./game";
import { bearingDeg, distanceM } from "./geo";

interface AutoBoard {
  point: LngLat | null;
  open: readonly Nearby[];
  move?: (at: LngLat, heading?: number) => void;
  approach: (mission: Nearby) => void;
  answer: () => Promise<void>;
  close: () => void;
  dismiss: () => void;
  currentMission?: string;
  takeover: boolean;
}

const durationMs = 240_000;

export function useAutoPlay(enabled: boolean, board: AutoBoard) {
  const current = useRef(board);
  current.current = board;
  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let timer = 0;
    let finishWait: (() => void) | undefined;
    let frame = 0;
    let finishWalk: (() => void) | undefined;
    const wait = (ms: number) => new Promise<void>(resolve => {
      finishWait = resolve;
      timer = window.setTimeout(resolve, ms);
    });
    const walk = (path: LngLat[], ms: number) => new Promise<void>(resolve => {
      finishWalk = resolve;
      const distances = path.slice(1).map((p, i) => distanceM(path[i]!, p));
      const length = distances.reduce((sum, d) => sum + d, 0);
      const start = performance.now();
      let lastUpdate = -Infinity;
      function tick(now: number) {
        if (stopped) { resolve(); return; }
        const t = Math.min(1, (now - start) / ms);
        if (now - lastUpdate >= 60 || t === 1) {
          let distance = length * t;
          let i = 0;
          while (i < distances.length - 1 && distance > distances[i]!) distance -= distances[i++]!;
          const a = path[i]!, b = path[i + 1]!;
          const fraction = distances[i] ? Math.min(1, distance / distances[i]!) : 1;
          current.current.move?.([a[0] + (b[0] - a[0]) * fraction, a[1] + (b[1] - a[1]) * fraction], bearingDeg(a,b));
          lastUpdate = now;
        }
        if (t < 1) frame = requestAnimationFrame(tick);
        else resolve();
      }
      frame = requestAnimationFrame(tick);
    });

    async function run() {
      const attempted = new Set<string>();
      const end = performance.now() + durationMs;
      let visitedVenue = false;
      while (!stopped && performance.now() < end) {
        const { point, open, move } = current.current;
        const available = open.filter(m => m.mission.type !== "obstacle_check" && !attempted.has(m.mission.id));
        const venue: Nearby | null | undefined = attempted.size > 0 && !visitedVenue ? available.find(m => m.mission.venueId) : null;
        const target: Nearby | undefined = venue ?? available[0];
        if (!point || !move || !target) { await wait(900); continue; }
        const { mission } = target;
        attempted.add(mission.id);
        const [lng,lat] = mission.position;

        if (end - performance.now() < 17_000) break;
        try {
          const { route } = await request<{route:Route}>("/route", {
            from:{lng:point[0],lat:point[1]}, to:{lng,lat}, profile:"voice",
          });
          if (stopped) break;
          const path = [point, ...route.geometry, mission.position];
          const travelMs = Math.max(8_000, Math.min(70_000, route.lengthM * 900));
          if (travelMs + 9_000 > end - performance.now()) continue;
          await walk(path, travelMs);
          if (stopped) break;
          // The mission list refreshes as the position moves. Wait for the ring's real reach rule.
          let arrived = current.current.open.find(m => m.mission.id === mission.id && m.reachable);
          for (let i=0; !arrived && !stopped && i<8; i++) {
            await wait(350);
            arrived = current.current.open.find(m => m.mission.id === mission.id && m.reachable);
          }
          if (!arrived || stopped) continue;
          current.current.approach(arrived);
          await wait(2700);
          if (stopped) break;
          if (current.current.currentMission === mission.id) {
            await current.current.answer();
            if (mission.venueId) visitedVenue = true;
            await wait(3100);
          }
          if (stopped) break;
          current.current.close();
          await wait(750);
          for (let i=0;i<2 && !stopped && current.current.takeover;i++) {
            await wait(2500);
            if (!stopped) current.current.dismiss();
            await wait(400);
          }
        } catch {
          // An unreachable or expired mission is skipped for this run.
        }
      }
    }
    void run();
    return () => {
      stopped = true;
      clearTimeout(timer);
      cancelAnimationFrame(frame);
      finishWait?.();
      finishWalk?.();
    };
  }, [enabled]);
}

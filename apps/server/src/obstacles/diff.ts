/** Compares two obstacle lists and says what a listening screen needs to hear. */
import type { Obstacle } from "@ion/core";

export type ObstacleEventType = "obstacle_added" | "obstacle_changed" | "obstacle_removed";

export interface ObstacleEvent {
  type: ObstacleEventType;
  obstacle: Obstacle;
  /** For `obstacle_changed`: the names of the fields that differ. */
  changed?: string[];
  at: string;
}

/** Fields whose change matters to routing or to what a person is told. */
const WATCHED = ["edgeId", "blocks", "confidence", "label", "expiresAt", "type"] as const;

export function diffObstacles(before: readonly Obstacle[], after: readonly Obstacle[], now: Date): ObstacleEvent[] {
  const at = now.toISOString();
  const old = new Map(before.map((o) => [o.id, o]));
  const events: ObstacleEvent[] = [];
  for (const o of after) {
    const prev = old.get(o.id);
    old.delete(o.id);
    if (!prev) {
      events.push({ type: "obstacle_added", obstacle: o, at });
      continue;
    }
    const changed = WATCHED.filter((k) => prev[k] !== o[k]);
    if (changed.length > 0) events.push({ type: "obstacle_changed", obstacle: o, changed: [...changed], at });
  }
  for (const gone of old.values()) events.push({ type: "obstacle_removed", obstacle: gone, at });
  return events;
}

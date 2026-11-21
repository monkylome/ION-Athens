import { useEffect, useRef } from "react";
import type { Obstacle } from "@ion/core";

const changes = ["obstacle_added", "obstacle_changed", "obstacle_removed"] as const;
type Event = { type: typeof changes[number]; obstacle: Obstacle; at: string } |
  { type: "snapshot"; obstacles: Obstacle[] };

export function useObstacleEvents(onEvent: (event: Event) => void) {
  const callback = useRef(onEvent);
  useEffect(() => { callback.current = onEvent; }, [onEvent]);
  useEffect(() => {
    const stream = new EventSource("/api/events");
    for (const type of ["snapshot", ...changes] as const) {
      stream.addEventListener(type, (message: MessageEvent<string>) => {
        callback.current({ ...JSON.parse(message.data), type });
      });
    }
    return () => stream.close();
  }, []);
}

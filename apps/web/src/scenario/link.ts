/**
 * Host and follower over a Transport. The host runs the engine and publishes
 * its state; a follower shows that state and sends commands back.
 */
import type { Transport, Wire } from "./transport";
import type { Command, ScenarioState } from "./types";

export interface HostLink {
  publish(state: ScenarioState): void;
  close(): void;
}

/** Publish state changes at most every `minIntervalMs`, and at once when anything but the walker changed. */
export function hostLink(
  transport: Transport,
  id: string,
  role: "stage" | "phone",
  onCommand: (command: Command) => void,
  current: () => ScenarioState,
  options: { minIntervalMs?: number; now?: () => number } = {},
): HostLink {
  const minInterval = options.minIntervalMs ?? 200;
  const now = options.now ?? (() => Date.now());
  let lastAt = -Infinity;
  let lastKey = "";
  const send = (state: ScenarioState) => transport.post({ t: "state", from: id, role, state });
  const off = transport.subscribe((message: Wire) => {
    if (message.from === id) return;
    if (message.t === "hello") send(current());
    if (message.t === "command") onCommand(message.command);
  });
  return {
    publish(state) {
      const key = structureKey(state);
      const t = now();
      if (key === lastKey && t - lastAt < minInterval) return;
      lastKey = key;
      lastAt = t;
      send(state);
    },
    close() {
      transport.post({ t: "bye", from: id });
      off();
    },
  };
}

/** Everything that must reach a follower immediately. The walker's position may wait for the next interval. */
function structureKey(s: ScenarioState): string {
  return [
    s.phase,
    s.waiting,
    s.injected,
    s.closing,
    s.crossingNotice, s.discoveryNotice?.label, s.discoveryNotice?.at.join(","), s.discoveryNotice?.seenBy,
    s.card?.name,
    s.paused,
    s.busy,
    s.connection,
    s.localFallback,
    s.destination?.name,
    s.route?.lengthM,
    s.caption?.id,
    s.caption?.revealed,
    s.caption?.done,
    s.moment?.id,
    s.moment?.beat,
    s.change?.id,
    s.metrics?.warningM,
    s.signal?.id,
    s.toasts.map((t) => t.id).join(","),
    s.obstacles.map((o) => `${o.obstacle.id}:${o.witnesses}:${o.closes}`).join(","),
    s.instruction?.title,
    s.instruction?.distance,
    s.notice,
  ].join("|");
}

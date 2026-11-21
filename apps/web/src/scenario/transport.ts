/**
 * How the tabs talk. Today: BroadcastChannel between tabs of one browser. A
 * relay for a second device only has to implement Transport.
 */
import type { Command, ScenarioState } from "./types";

export type Wire =
  | { t: "hello"; from: string }
  | { t: "state"; from: string; role: "stage" | "phone"; state: ScenarioState }
  | { t: "command"; from: string; command: Command }
  | { t: "bye"; from: string };

export interface Transport {
  post(message: Wire): void;
  subscribe(listener: (message: Wire) => void): () => void;
  close(): void;
}

export function broadcastTransport(name = "ion-scenario"): Transport | null {
  if (typeof BroadcastChannel === "undefined") return null;
  const channel = new BroadcastChannel(name);
  const listeners = new Set<(message: Wire) => void>();
  channel.onmessage = (event: MessageEvent<Wire>) => {
    for (const listener of listeners) listener(event.data);
  };
  return {
    post: (message) => channel.postMessage(message),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close: () => channel.close(),
  };
}

/** Transports that deliver to each other, for tests and for a page without BroadcastChannel. */
export function memoryHub(): () => Transport {
  const ends = new Set<(message: Wire) => void>();
  return () => {
    const mine = new Set<(message: Wire) => void>();
    const deliver = (message: Wire) => mine.forEach((listener) => listener(message));
    ends.add(deliver);
    return {
      post(message) {
        for (const end of ends) if (end !== deliver) end(structuredClone(message));
      },
      subscribe(listener) {
        mine.add(listener);
        return () => {
          mine.delete(listener);
        };
      },
      close: () => {
        ends.delete(deliver);
      },
    };
  };
}

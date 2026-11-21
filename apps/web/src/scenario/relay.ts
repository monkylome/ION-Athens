/**
 * A Transport over the server's room channel, so a real phone can follow the
 * stage across the network. Select it with `?room=NAME` on /stage and /phone.
 * The server relays each message and keeps nothing.
 */
import { joinRoom } from "../assist/room";
import { broadcastTransport, type Transport, type Wire } from "./transport";

const ROOM = /^[A-Za-z0-9_-]{1,40}$/;

export function relayTransport(room: string): Transport {
  const member = "relay" + Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
  const listeners = new Set<(message: Wire) => void>();
  let ready: () => void = () => undefined;
  const joined = new Promise<void>((resolve) => { ready = resolve; });
  const link = joinRoom(room, member, {
    onHello: () => ready(),
    onMessage: (_from, data) => {
      if (data && typeof data === "object") for (const listener of listeners) listener(data as Wire);
    },
  });
  return {
    // Messages wait for the join, so a "hello" sent at once is not lost.
    post: (message) => void joined.then(() => link.send(message)),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close: () => link.close(),
  };
}

/** The relay when the page has `?room=NAME`, otherwise the tabs of this browser. */
export function selectTransport(search = typeof location === "undefined" ? "" : location.search): Transport | null {
  const room = new URLSearchParams(search).get("room");
  return room && ROOM.test(room) && typeof EventSource !== "undefined" ? relayTransport(room) : broadcastTransport();
}

/**
 * The game's calls to the server. Same endpoints and the same participant id
 * as the plain missions list (`src/missions/Missions.tsx`), so points earned
 * on either screen belong to the same random id on this device.
 */
import type { LngLat } from "@ion/core";
import type { Answer, AnswerResult, Board, Profile, Rewards, Venue } from "./game";

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly distanceM?: number) {
    super(message);
  }
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch("/api" + path, body === undefined ? undefined : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError("Δεν υπάρχει σύνδεση με τον διακομιστή.", 0, "network");
  }
  if (!response.ok) {
    const data = await response.json().catch(() => null) as { error?: { code?: string; message?: string; distanceM?: number } } | null;
    throw new ApiError(data?.error?.message ?? `HTTP ${response.status}`, response.status, data?.error?.code, data?.error?.distanceM);
  }
  return response.json() as Promise<T>;
}



/** A random id made on this device. Not a person: no name, no account, no position history. */
export function participantId(): string {
  const key = new URLSearchParams(location.search).get("demo") === "1" ? "ion-demo-participant" : "ion-participant";
  try {
    const previous = localStorage.getItem(key);
    if (previous) return previous;
  } catch { /* private mode: an id for this visit only */ }
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  try { localStorage.setItem(key, id); } catch { /* as above */ }
  return id;
}

export const playApi = {
  missions: (at: LngLat, radius: number, limit: number) =>
    call<Board>(`/missions?lng=${at[0]}&lat=${at[1]}&radius=${radius}&limit=${limit}`),
  profile: (participant: string) => call<Profile>(`/missions/profile?participant=${participant}`),
  /** `demo` asks for the labelled rehearsal thresholds; the server ignores it when demo control is off. */
  rewards: (participant: string, demo = false) => call<Rewards>(`/rewards?participant=${participant}${demo ? "&demo=true" : ""}`),
  venue: (id: string) => call<Venue>(`/venues/${encodeURIComponent(id)}`),
  /** The rehearsed stage geometry: where the presenter starts and the place the walk ends at. */
  demoLoop: (preset: string) => call<{ start?: { lng: number; lat: number }; destination?: { lng: number; lat: number } }>("/demo/loop?preset=" + encodeURIComponent(preset)),
  /** The scan mode's own endpoints. They may not exist: every caller treats a failure as "no scan mode". */
  visionStatus: () => call<unknown>("/vision/status"),
  discoveries: () => call<{ discoveries: unknown[] }>("/vision/discoveries"),
  neighbourhoods: () => call<unknown>("/neighbourhoods"),
  /** A real answer carries the position for the server's distance check; the server does not store it. */
  answer: (id: string, participant: string, answer: Answer, at: LngLat) =>
    call<AnswerResult>(`/missions/${encodeURIComponent(id)}/answer`, { participant, answer, lng: at[0], lat: at[1] }),
  /** The presenter's answer: the same rules without the distance check. Always labelled on screen. */
  demoAnswer: (id: string, participant: string, answer: Answer) =>
    call<AnswerResult>(`/demo/missions/${encodeURIComponent(id)}/answer`, { participant, answer }),
};

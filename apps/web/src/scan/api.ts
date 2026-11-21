import type { ConfirmResult, Proposal } from "./logic";

export interface VisionStatus {
  configured: boolean;
  answering: boolean;
  model: string | null;
  licence: string | null;
  medianLatencyMs: number | null;
  kept: number;
  notice: string;
}
export interface ObserveBody {
  image: string;
  lng: number;
  lat: number;
  heading?: number;
  participant: string;
  purpose: "map" | "describe";
  keep?: boolean;
}
export interface ObserveResult {
  purpose: "map" | "describe";
  model?: string;
  ms?: number;
  kept?: boolean;
  queued?: boolean;
  message?: string;
  proposals?: Proposal[];
  speech?: string;
}

export class VisionError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
  }
}

async function call<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch("/api/vision" + path, body === undefined ? undefined : { signal, method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new VisionError("Δεν υπάρχει σύνδεση με τον διακομιστή.", 0, "offline");
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new VisionError(data?.error?.message ?? `Σφάλμα ${response.status}`, response.status, data?.error?.code ?? "error");
  return data as T;
}

export const vision = {
  status: () => call<VisionStatus>("/status"),
  observe: (body: ObserveBody, signal?: AbortSignal) => call<ObserveResult>("/observe", body, signal),
  confirm: (participant: string, proposal: Proposal, at: { lng: number; lat: number }) =>
    call<ConfirmResult>("/confirm", { participant, proposal: { kind: proposal.kind, text: proposal.text, mission: proposal.mission ? { id: proposal.mission.id } : undefined }, lng: at.lng, lat: at.lat, missionId: proposal.mission?.id }),
};

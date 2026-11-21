import { request } from "../api/client";
import type { MarkKind } from "./config";

export interface Reward {
  rewarded: boolean;
  pointsEarned: number;
  durationS: number;
  reason?: "too_short" | "daily_limit";
  profile: Profile;
}
export interface Profile { points: number; level: string; nextLevel: { name: string; pointsNeeded: number } | null }
export interface RequestView {
  id: string;
  status: "open" | "accepted" | "ended" | "expired";
  role: "person" | "helper" | null;
  room?: string;
  endReason?: string;
  reward?: Reward;
  expiresAt: string;
}
export interface OpenRequest { id: string; area: string; distanceM: number; text: string; waitingS: number; expiresInS: number }
export interface MarkResult {
  observation: { id: string; label: string };
  pointsEarned: number;
  profile: Profile;
  report: { id: string } | null;
  reportProblem?: string;
}

const get = async <T>(path: string): Promise<T> => {
  const response = await fetch("/api/assist" + path);
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw Object.assign(new Error(data?.error?.message ?? `HTTP ${response.status}`), { status: response.status, code: data?.error?.code });
  }
  return response.json();
};
const post = <T>(path: string, body: unknown) => request<T>("/assist" + path, body);

export const assist = {
  open: (device: string, lng: number, lat: number, text?: string) =>
    post<{ request: RequestView; waitS: number }>("/requests", { device, lng, lat, ...(text ? { text } : {}) }),
  status: (id: string, device: string) => get<{ request: RequestView }>(`/requests/${id}?device=${device}`),
  nearby: (lng: number, lat: number) => get<{ requests: OpenRequest[] }>(`/requests?lng=${lng}&lat=${lat}&radius=3000`),
  accept: (id: string, device: string) => post<{ request: RequestView }>(`/requests/${id}/accept`, { device }),
  end: (id: string, device: string) => post<{ request: RequestView }>(`/requests/${id}/end`, { device }),
  mark: (id: string, device: string, kind: MarkKind, lng: number, lat: number) =>
    post<MarkResult>(`/requests/${id}/marks`, { device, kind, lng, lat }),
};

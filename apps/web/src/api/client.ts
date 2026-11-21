import type { Obstacle, Route } from "@ion/core";

type Point = { lng: number; lat: number };
type Place = Point & { id: string | null; name: string; address: string | null };
type ReportInput = Point & { category?: string; text?: string };
type ReportResult = { report: Point & { id: string }; obstacle: Obstacle | null };
type Destination = { speech: string } & (
  { understood: true; place: Place; confidence: number; alternatives: Place[] } |
  { understood: false; reason: string }
);

export async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch("/api" + path, body === undefined ? undefined : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error?.message ?? `HTTP ${response.status}`);
  }
  return response.json();
}
export const api = {
  health: () => request<{ ok: boolean; time: string }>("/health"),
  obstacles: () => request<{ stale: boolean; obstacles: Obstacle[] }>("/obstacles"),
  places: (query: string) => request<{ places: Place[] }>(`/places?q=${encodeURIComponent(query)}`),
  destination: (text: string, location?: Point) => request<Destination>("/destination", { text, location }),
  route: (from: Point, to: Point) => request<{ route: Route; rerouted: boolean; obstacles: Obstacle[] }>("/route", { from, to }),
  report: (input: ReportInput) => request<ReportResult>("/reports", input),
  confirm: (id: string) => request<ReportResult>(`/reports/${encodeURIComponent(id)}/confirm`, {}),
  demoObstacle: (input: ReportInput) => request<ReportResult>("/demo/obstacle", input),
  demoResolve: (id: string) => request<ReportResult>(`/demo/resolve/${encodeURIComponent(id)}`, {}),
  demoReset: () => request<{ reset: boolean }>("/demo/reset", {}),
};

/** STUN servers for the call. Override with VITE_ICE_SERVERS, a JSON list of RTCIceServer. Host candidates always work on one network. */
const DEFAULT: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

export function iceServers(): RTCIceServer[] {
  const raw = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_ICE_SERVERS;
  if (!raw) return DEFAULT;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as RTCIceServer[]) : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

/** The person waits 15 seconds for a connection before trying audio only. */
export const CONNECT_TIMEOUT_MS = 15_000;
/** A connection that is down this long counts as lost. */
export const LOST_AFTER_MS = 4_000;

export const MARKS = [
  { kind: "ramp", label: "Ράμπα" },
  { kind: "steps", label: "Σκαλιά" },
  { kind: "sidewalk_obstacle", label: "Εμπόδιο στο πεζοδρόμιο" },
  { kind: "audible_signal", label: "Φανάρι με ήχο" },
  { kind: "narrow_sidewalk", label: "Στενό πεζοδρόμιο" },
  { kind: "clear_path", label: "Ελεύθερος δρόμος" },
] as const;
export type MarkKind = (typeof MARKS)[number]["kind"];

export const NO_RECORDING = "Δεν γίνεται καμία εγγραφή και δεν αποθηκεύεται κανένα καρέ.";

/**
 * One call between the person (who sends video and audio) and the helper (who
 * sends audio). The person always makes the offer, so the two never collide.
 * Signalling goes through a room; the media goes straight between the phones.
 * Nothing is recorded and no frame touches the server.
 */
import { CONNECT_TIMEOUT_MS, LOST_AFTER_MS } from "./config";

export type CallState = "connecting" | "connected" | "lost" | "failed";
export type CallMode = "video" | "audio";

export interface CallOptions {
  role: "person" | "helper";
  /** Send a signalling message to the other side. */
  send(data: unknown): void;
  /** What this side sends: camera and microphone for the person, microphone for the helper. May be null. */
  local: MediaStream | null;
  iceServers: RTCIceServer[];
  connectTimeoutMs?: number;
  lostAfterMs?: number;
  onState(state: CallState, mode: CallMode): void;
  onRemote(stream: MediaStream | null): void;
}

type Signal =
  | { t: "offer"; attempt: number; mode: CallMode; sdp: RTCSessionDescriptionInit }
  | { t: "answer"; attempt: number; sdp: RTCSessionDescriptionInit }
  | { t: "ice"; attempt: number; c: RTCIceCandidateInit }
  | { t: "failed" };

export class Call {
  private pc: RTCPeerConnection | null = null;
  private attempt = 0;
  private mode: CallMode = "video";
  private retried = false;
  private wasConnected = false;
  private pendingIce: RTCIceCandidateInit[] = [];
  private connectTimer: ReturnType<typeof setTimeout> | undefined;
  private lostTimer: ReturnType<typeof setTimeout> | undefined;
  private done = false;
  private muted = false;

  constructor(private readonly o: CallOptions) {}

  /** Person only: make the first offer. */
  start(): void {
    const hasVideo = !!this.o.local?.getVideoTracks().length;
    void this.begin(hasVideo ? "video" : "audio");
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    for (const t of this.o.local?.getAudioTracks() ?? []) t.enabled = !muted;
  }

  close(): void {
    this.done = true;
    this.teardown();
  }

  private teardown() {
    clearTimeout(this.connectTimer);
    clearTimeout(this.lostTimer);
    if (this.pc) {
      this.pc.onicecandidate = this.pc.onconnectionstatechange = this.pc.ontrack = null;
      this.pc.close();
      this.pc = null;
    }
    this.pendingIce = [];
  }

  private newPeer(mode: CallMode): RTCPeerConnection {
    this.teardown();
    this.wasConnected = false;
    const pc = new RTCPeerConnection({ iceServers: this.o.iceServers });
    this.pc = pc;
    for (const track of this.o.local?.getTracks() ?? []) {
      if (track.kind === "video" && mode === "audio") continue;
      if (track.kind === "audio") track.enabled = !this.muted;
      pc.addTrack(track, this.o.local!);
    }
    pc.onicecandidate = (e) => {
      if (e.candidate && this.pc === pc) this.o.send({ t: "ice", attempt: this.attempt, c: e.candidate.toJSON() } satisfies Signal);
    };
    pc.ontrack = (e) => {
      if (this.pc !== pc) return;
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      this.o.onRemote(stream);
    };
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc || this.done) return;
      const s = pc.connectionState;
      if (s === "connected") {
        clearTimeout(this.connectTimer);
        clearTimeout(this.lostTimer);
        this.wasConnected = true;
        this.o.onState("connected", this.mode);
      } else if (s === "disconnected") {
        clearTimeout(this.lostTimer);
        this.lostTimer = setTimeout(() => this.lost(), this.o.lostAfterMs ?? LOST_AFTER_MS);
      } else if (s === "failed") {
        this.lost();
      }
    };
    return pc;
  }

  private async begin(mode: CallMode): Promise<void> {
    if (this.done) return;
    this.attempt++;
    this.mode = mode;
    this.o.onState("connecting", mode);
    const pc = this.newPeer(mode);
    this.connectTimer = setTimeout(() => this.timedOut(), this.o.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (this.pc !== pc) return;
      this.o.send({ t: "offer", attempt: this.attempt, mode, sdp: pc.localDescription!.toJSON() } satisfies Signal);
    } catch {
      this.timedOut();
    }
  }

  /** Person: the connection did not come up in time, or went down. */
  private timedOut() {
    if (this.done || this.o.role !== "person") return;
    if (this.mode === "video" && this.o.local?.getAudioTracks().length) void this.begin("audio");
    else this.fail();
  }

  private lost() {
    if (this.done) return;
    clearTimeout(this.lostTimer);
    if (this.o.role === "helper") {
      this.o.onState("lost", this.mode);
      return;
    }
    if (!this.wasConnected) return this.timedOut();
    this.o.onState("lost", this.mode);
    if (!this.retried) {
      this.retried = true;
      void this.begin(this.mode);
    } else this.timedOut();
  }

  private fail() {
    this.o.send({ t: "failed" } satisfies Signal);
    this.teardown();
    this.o.onState("failed", this.mode);
  }

  /** A signalling message from the other side. */
  async handle(raw: unknown): Promise<void> {
    if (this.done || !raw || typeof raw !== "object") return;
    const m = raw as Signal;
    try {
      if (m.t === "failed") {
        this.teardown();
        this.o.onState("failed", this.mode);
      } else if (m.t === "offer" && this.o.role === "helper") {
        if (m.attempt < this.attempt) return;
        this.attempt = m.attempt;
        this.mode = m.mode;
        this.o.onState("connecting", m.mode);
        if (m.mode === "audio") this.o.onRemote(null);
        const pc = this.newPeer(m.mode);
        await pc.setRemoteDescription(m.sdp);
        await this.flushIce(pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await this.flushIce(pc);
        if (this.pc === pc) this.o.send({ t: "answer", attempt: m.attempt, sdp: pc.localDescription!.toJSON() } satisfies Signal);
      } else if (m.t === "answer" && this.o.role === "person" && this.pc && m.attempt === this.attempt) {
        await this.pc.setRemoteDescription(m.sdp);
        await this.flushIce(this.pc);
      } else if (m.t === "ice" && m.attempt === this.attempt) {
        if (this.pc?.remoteDescription) await this.pc.addIceCandidate(m.c);
        else this.pendingIce.push(m.c);
      }
    } catch {
      if (this.o.role === "person") this.timedOut();
      else this.o.onState("failed", this.mode);
    }
  }

  private async flushIce(pc: RTCPeerConnection) {
    const queued = this.pendingIce;
    this.pendingIce = [];
    for (const c of queued) await pc.addIceCandidate(c);
  }
}

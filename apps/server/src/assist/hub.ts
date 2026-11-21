/**
 * A small room channel: members join a room, receive what others send to the
 * room or to them, and leave. Messages are relayed and never stored.
 * Everything is bounded: rooms, members, message size, message rate, queue.
 */
export interface HubOptions {
  maxRooms: number;
  maxMembersPerRoom: number;
  maxMessageBytes: number;
  /** Messages one member may send per window. */
  maxMessagesPerWindow: number;
  windowMs: number;
  /** A member silent for this long is removed. */
  memberTtlMs: number;
  /** Messages waiting for one member before it is dropped as too slow. */
  maxQueue: number;
}

export const DEFAULT_HUB_OPTIONS: HubOptions = {
  maxRooms: 200,
  maxMembersPerRoom: 8,
  maxMessageBytes: 128 * 1024,
  maxMessagesPerWindow: 200,
  windowMs: 10_000,
  memberTtlMs: 45_000,
  maxQueue: 200,
};

export interface RoomEvent {
  event: "hello" | "message" | "member_joined" | "member_left" | "closed";
  data: unknown;
}

export interface Member {
  id: string;
  deliver(event: RoomEvent): void;
  /** Called once when the hub removes the member. */
  close(reason: "left" | "replaced" | "expired" | "room_closed" | "too_slow"): void;
  lastSeen: number;
  sent: number[];
}

interface Room {
  members: Map<string, Member>;
  maxMembers: number;
  pinned: boolean;
}

export type HubResult<T = object> = ({ ok: true } & T) | { ok: false; code: "room_limit" | "room_full" | "too_large" | "rate_limited" | "not_member" | "recipient_gone"; message: string };

export class RoomHub {
  readonly opts: HubOptions;
  private readonly rooms = new Map<string, Room>();

  constructor(opts: Partial<HubOptions> = {}, private readonly now: () => number = () => Date.now()) {
    this.opts = { ...DEFAULT_HUB_OPTIONS, ...opts };
  }

  has(room: string): boolean {
    return this.rooms.has(room);
  }

  roomCount(): number {
    return this.rooms.size;
  }

  members(room: string): string[] {
    return [...(this.rooms.get(room)?.members.keys() ?? [])];
  }

  /** Reserve a room with its own member limit. It stays until closed. */
  open(room: string, maxMembers: number): boolean {
    if (this.rooms.has(room)) return true;
    if (this.rooms.size >= this.opts.maxRooms) return false;
    this.rooms.set(room, { members: new Map(), maxMembers, pinned: true });
    return true;
  }

  join(room: string, id: string, deliver: Member["deliver"], close: Member["close"]): HubResult<{ members: string[] }> {
    let r = this.rooms.get(room);
    if (!r) {
      if (this.rooms.size >= this.opts.maxRooms) return { ok: false, code: "room_limit", message: "Υπάρχουν πάρα πολλά ανοιχτά δωμάτια." };
      r = { members: new Map(), maxMembers: this.opts.maxMembersPerRoom, pinned: false };
      this.rooms.set(room, r);
    }
    const previous = r.members.get(id);
    if (!previous && r.members.size >= r.maxMembers) return { ok: false, code: "room_full", message: "Το δωμάτιο είναι γεμάτο." };
    if (previous) {
      r.members.delete(id);
      previous.close("replaced");
    }
    const others = [...r.members.keys()];
    const member: Member = { id, deliver, close, lastSeen: this.now(), sent: [] };
    r.members.set(id, member);
    this.push(r, member, { event: "hello", data: { room, self: id, members: others } });
    for (const other of r.members.values()) if (other !== member) this.push(r, other, { event: "member_joined", data: { member: id } });
    return { ok: true, members: others };
  }

  /** Marks a member as alive. */
  touch(room: string, id: string): void {
    const m = this.rooms.get(room)?.members.get(id);
    if (m) m.lastSeen = this.now();
  }

  leave(room: string, id: string, reason: Parameters<Member["close"]>[0] = "left", only?: Member["deliver"]): void {
    const r = this.rooms.get(room);
    const m = r?.members.get(id);
    if (!r || !m || (only && m.deliver !== only)) return;
    r.members.delete(id);
    m.close(reason);
    for (const other of r.members.values()) this.push(r, other, { event: "member_left", data: { member: id } });
    this.dropIfEmpty(room, r);
  }

  send(room: string, from: string, data: unknown, to?: string): HubResult<{ delivered: number }> {
    const r = this.rooms.get(room);
    const me = r?.members.get(from);
    if (!r || !me) return { ok: false, code: "not_member", message: "Δεν είστε μέλος αυτού του δωματίου." };
    const size = JSON.stringify(data ?? null).length;
    if (size > this.opts.maxMessageBytes) return { ok: false, code: "too_large", message: "Το μήνυμα είναι πολύ μεγάλο." };
    const t = this.now();
    me.lastSeen = t;
    me.sent = me.sent.filter((s) => t - s < this.opts.windowMs);
    if (me.sent.length >= this.opts.maxMessagesPerWindow) return { ok: false, code: "rate_limited", message: "Πολλά μηνύματα μέσα σε λίγο χρόνο." };
    me.sent.push(t);
    const event: RoomEvent = { event: "message", data: { from, ...(to ? { to } : {}), data, at: new Date(t).toISOString() } };
    let delivered = 0;
    if (to) {
      const target = r.members.get(to);
      if (!target) return { ok: false, code: "recipient_gone", message: "Ο παραλήπτης δεν είναι πια στο δωμάτιο." };
      this.push(r, target, event);
      return { ok: true, delivered: 1 };
    }
    for (const m of [...r.members.values()]) if (m !== me) { this.push(r, m, event); delivered++; }
    return { ok: true, delivered };
  }

  /** Tell everyone, remove everyone and delete the room. */
  closeRoom(room: string, reason: unknown = { reason: "closed" }): void {
    const r = this.rooms.get(room);
    if (!r) return;
    this.rooms.delete(room);
    for (const m of r.members.values()) {
      try { m.deliver({ event: "closed", data: reason }); } catch { /* the member is gone anyway */ }
      m.close("room_closed");
    }
  }

  /** Remove members that went silent. Call from a timer. */
  sweep(): number {
    const t = this.now();
    let removed = 0;
    for (const [name, r] of [...this.rooms]) {
      for (const m of [...r.members.values()]) {
        if (t - m.lastSeen > this.opts.memberTtlMs) {
          this.leave(name, m.id, "expired");
          removed++;
        }
      }
    }
    return removed;
  }

  private dropIfEmpty(name: string, r: Room) {
    if (r.members.size === 0 && !r.pinned && this.rooms.get(name) === r) this.rooms.delete(name);
  }

  private push(r: Room, m: Member, event: RoomEvent) {
    try {
      m.deliver(event);
    } catch {
      r.members.delete(m.id);
      m.close("too_slow");
    }
  }
}

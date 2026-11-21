/** One end of a room on the server: Server-Sent Events to receive, POST to send. */
export interface RoomHandlers {
  onHello?(members: string[]): void;
  onMessage?(from: string, data: unknown): void;
  onJoined?(member: string): void;
  onLeft?(member: string): void;
  /** The server closed the room, for example because the call ended. */
  onClosed?(reason: unknown): void;
  /** The stream cannot be opened or was refused. */
  onFailed?(status: "refused" | "lost"): void;
}

export interface RoomLink {
  send(data: unknown, to?: string): Promise<boolean>;
  close(): void;
}

export function joinRoom(room: string, member: string, handlers: RoomHandlers): RoomLink {
  const source = new EventSource(`/api/assist/rooms/${encodeURIComponent(room)}/events?member=${encodeURIComponent(member)}`);
  let closed = false;
  const listen = (name: string, fn: (data: any) => void) => // eslint-disable-line @typescript-eslint/no-explicit-any
    source.addEventListener(name, (event) => {
      try { fn(JSON.parse((event as MessageEvent<string>).data)); } catch { /* ignore a broken frame */ }
    });
  listen("hello", (d) => handlers.onHello?.(d.members ?? []));
  listen("message", (d) => handlers.onMessage?.(d.from, d.data));
  listen("member_joined", (d) => handlers.onJoined?.(d.member));
  listen("member_left", (d) => handlers.onLeft?.(d.member));
  listen("closed", (d) => {
    closed = true;
    source.close();
    handlers.onClosed?.(d);
  });
  source.onerror = () => {
    if (closed) return;
    // CLOSED means the browser gave up, which is what a 4xx answer looks like.
    if (source.readyState === EventSource.CLOSED) handlers.onFailed?.("refused");
    else handlers.onFailed?.("lost");
  };
  // Messages must arrive in the order they were sent, so they go one at a time.
  let chain: Promise<unknown> = Promise.resolve();
  return {
    send(data, to) {
      const run = chain.then(async () => {
        try {
          const response = await fetch(`/api/assist/rooms/${encodeURIComponent(room)}/messages`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: member, ...(to ? { to } : {}), data }),
          });
          return response.ok;
        } catch {
          return false;
        }
      });
      chain = run;
      return run;
    },
    close() {
      closed = true;
      source.close();
      void fetch(`/api/assist/rooms/${encodeURIComponent(room)}/leave`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ member }), keepalive: true,
      }).catch(() => undefined);
    },
  };
}

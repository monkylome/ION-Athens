import { afterEach, describe, expect, it, vi } from "vitest";
import { selectTransport } from "./relay";

describe("selectTransport", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the browser's own channel without ?room, and with a room name that is not valid", () => {
    const t = selectTransport("");
    expect(t).not.toBeNull();
    t?.close();
    const u = selectTransport("?room=bad name!");
    expect(u).not.toBeNull();
    u?.close();
  });

  it("opens the room channel with ?room=NAME and sends only after the join", async () => {
    const posted: string[] = [];
    class FakeSource {
      static CLOSED = 2;
      readyState = 1;
      onerror: (() => void) | null = null;
      listeners = new Map<string, (e: { data: string }) => void>();
      constructor(public url: string) {
        sources.push(this);
      }
      addEventListener(name: string, fn: (e: { data: string }) => void) { this.listeners.set(name, fn); }
      close() { this.readyState = 2; }
    }
    const sources: FakeSource[] = [];
    vi.stubGlobal("EventSource", FakeSource);
    vi.stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
      if (String(url).endsWith("/messages")) posted.push(init!.body!);
      return { ok: true };
    });
    const t = selectTransport("?room=demo-1")!;
    expect(sources[0]!.url).toMatch(/\/api\/assist\/rooms\/demo-1\/events\?member=relay/);
    const heard: unknown[] = [];
    t.subscribe((m) => heard.push(m));
    t.post({ t: "hello", from: "a" });
    await Promise.resolve();
    expect(posted).toHaveLength(0);
    sources[0]!.listeners.get("hello")!({ data: JSON.stringify({ members: [] }) });
    await new Promise((r) => setTimeout(r, 0));
    expect(posted).toHaveLength(1);
    expect(JSON.parse(posted[0]!).data).toEqual({ t: "hello", from: "a" });
    sources[0]!.listeners.get("message")!({ data: JSON.stringify({ from: "x", data: { t: "bye", from: "x" } }) });
    expect(heard).toEqual([{ t: "bye", from: "x" }]);
    t.close();
  });
});

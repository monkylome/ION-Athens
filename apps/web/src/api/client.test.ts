import { afterEach, expect, it, vi } from "vitest";
import { api } from "./client";
afterEach(() => vi.unstubAllGlobals());
it("encodes place queries and reads JSON", async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ places: [] }));
  vi.stubGlobal("fetch", fetch);
  expect(await api.places("A & B")).toEqual({ places: [] });
  expect(fetch).toHaveBeenCalledWith("/api/places?q=A%20%26%20B", undefined);
});
it("surfaces server error messages", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: { message: "No route" } }, { status: 404 })));
  await expect(api.route({ lng: 0, lat: 0 }, { lng: 1, lat: 1 })).rejects.toThrow("No route");
});

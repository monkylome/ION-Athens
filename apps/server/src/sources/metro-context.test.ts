import { expect, it, vi } from "vitest";
import { parseEntrances, stationsAdapter } from "./metro.ts";
import { findStation } from "./stasy.ts";
import { gisAdapter, LAYERS } from "./gis.ts";
import { parseWeather } from "./weather.ts";

it("preserves quoted commas, newlines and escaped quotes at a station", () => {
  const data = '\uFEFFΣταθμός,Σημεία,Latitude,Longitude,Κατεύθυνση προς ,Πληροφορίες\r\nΔοκιμή,"Οδός Α, 4",37.98,23.72,Κέντρο,"Από τη στοά\nμε την πινακίδα ""Α"""';
  expect(parseEntrances(data)).toEqual([{station:"Δοκιμή",entrance:"Οδός Α, 4",lat:37.98,lng:23.72,direction:"Κέντρο",description:'Από τη στοά\nμε την πινακίδα "Α"'}]);
});
it("matches station names with Greek accents and deduplicates OSM geometries", async () => {
  const row = {id:"n1",name:"Δοκιμή",kind:"metro_station",lat:38,lng:23.7};
  const stations = stationsAdapter(async () => JSON.stringify([row,{...row,id:"w2",name:"ΔΟΚΙΜΗ"}]));
  const env = {now:()=>new Date(), fetch,timeoutMs:1000,retryDelayMs:0};
  const result = await stations.fetch(undefined,env);
  expect(result).toHaveLength(1);
  expect(findStation([{station:"ΔΟΚΙΜΗ",lines:[],lifts:[],outOfService:[]}],result[0]!.name)?.station).toBe("ΔΟΚΙΜΗ");
});
it("uses the HTTPS WFS first and falls back on an incompatible response", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response("<Exception/>")).mockResolvedValueOnce(Response.json({features:[]}));
  const adapter = gisAdapter(LAYERS[0]!);
  await adapter.fetch(undefined,{fetch:fetcher,now:()=>new Date(),timeoutMs:1000,retryDelayMs:0});
  expect(fetcher.mock.calls.map(([url])=>new URL(url).hostname)).toEqual(["maps.cityofathens.gr","gis.cityofathens.gr"]);
});
it("returns the next three hours, preserving missing rain values", () => {
  const weather = parseWeather({current:{time:100,rain:0},hourly:{time:[0,3600,7200,10800,14400],rain:[2,null,0,1,3]}});
  expect(weather.nextHours.map(h=>h.rainMm)).toEqual([null,0,1]);
  expect(weather.speech).toContain("Αναμένεται βροχή");
});

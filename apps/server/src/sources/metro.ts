import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { fetchText } from "./http.ts";
import { fold } from "./text.ts";
import type { SourceAdapter } from "./types.ts";

export interface Station { id: string; name: string; lat: number; lng: number }
export interface LiftEntrance { station: string; entrance: string; direction: string; description: string; lat: number; lng: number }
const placesFile = fileURLToPath(new URL("../../../../data/places.json", import.meta.url));
export function stationsAdapter(read = (path: string) => readFile(path, "utf8")): SourceAdapter<Station> {
  return {
    meta: { id: "osm-metro", name: "Σταθμοί μετρό", owner: "OpenStreetMap contributors", gives: "Συντεταγμένες σταθμών από το τοπικό αρχείο",
      kind: "static", data: "real", terms: "ODbL", termsUrl: "https://www.openstreetmap.org/copyright", termsQuoted: false, permission: "open licence", request: "data/places.json" },
    ttlMs: 86400000, timeoutMs: 3000,
    async fetch() {
      const places = z.array(z.object({id:z.string(),kind:z.string(),name:z.string(),lng:z.number(),lat:z.number()})).parse(JSON.parse(await read(placesFile)));
      const stations = new Map<string,Station>();
      for (const place of places) {
        const key = fold(place.name);
        if (place.kind === "metro_station" && !stations.has(key)) stations.set(key,place);
      }
      return [...stations.values()];
    },
  };
}

/** RFC 4180 fields, including doubled quotes and embedded CR/LF in quoted descriptions. */
export function parseEntrances(csv: string): LiftEntrance[] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  const source = csv.replace(/^\uFEFF/, "");
  for (let i=0; i<source.length; i++) {
    const c = source[i]!;
    if (c === '"') {
      if (quoted && source[i+1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && c === ",") { row.push(field.trim()); field=""; }
    else if (!quoted && (c === "\n" || c === "\r")) {
      if (c === "\r" && source[i+1] === "\n") i++;
      row.push(field.trim()); rows.push(row); row=[]; field="";
    } else field += c;
  }
  if (quoted) throw new Error("Incomplete quoted lift entrance field");
  if (field || row.length) rows.push([...row,field.trim()]);
  const header = rows.shift()?.map(fold) ?? [];
  const columns = ["Σταθμός","Σημεία","Latitude","Longitude","Κατεύθυνση προς","Πληροφορίες"].map(h=>header.indexOf(fold(h)));
  if (columns.includes(-1)) throw new Error("Unexpected lift entrance columns");
  return rows.flatMap(r=>{
    const [station,entrance,latitude,longitude,direction,description] = columns.map(i=>r[i] ?? "");
    const lat = Number(latitude), lng = Number(longitude);
    if (!station || !entrance || !(lat>37 && lat<39 && lng>23 && lng<25)) return [];
    return [{station, entrance, lat, lng, direction:direction ?? "", description:description ?? ""}];
  });
}
const entranceUrl = "https://data.gov.gr/dataset/c6820cf0-5db4-4d22-9408-16bcff925af9/resource/ba897503-85ba-4978-87eb-1ed7d355b0c7/download/anelkistires_stasy_csv.csv";
export const entrancesAdapter: SourceAdapter<LiftEntrance> = {
  meta: {id:"stasy-entrances",name:"Είσοδοι ανελκυστήρων",owner:"ΣΤΑΣΥ / data.gov.gr",gives:"Θέσεις και οδηγίες για εισόδους της Γραμμής 1",
    kind:"static",data:"real",terms:"Licence field empty on data.gov.gr; NAP copy states CC BY 4.0. Confirmation pending.",termsUrl:entranceUrl,termsQuoted:false,permission:"pending",request:entranceUrl},
  ttlMs:86400000,timeoutMs:8000,
  async fetch(_,env) { return parseEntrances(await fetchText(env,entranceUrl,"STASY lift entrances","text/csv,*/*")); },
};

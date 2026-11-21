import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import type { LngLat } from "@ion/core";
import { streetKey } from "./decision-parser.ts";

const cacheDir = fileURLToPath(new URL("../../../../data-local/diavgeia-addresses/",import.meta.url));
function file(street: string, number: string) {
  return join(cacheDir,createHash("sha256").update(streetKey(street)+" "+number).digest("hex")+".json");
}
export async function cachedAddress(street: string, number: string): Promise<LngLat | null | undefined> {
  try {
    const value = JSON.parse(await readFile(file(street,number),"utf8"));
    if (value === null) return null;
    if (Array.isArray(value) && value.length===2 && value.every(Number.isFinite)) return [value[0],value[1]];
  } catch { /* Missing or invalid cache. */ }
  return undefined;
}
/** Only invoked explicitly with a saved /api/decisions response. The web server never sends an address lookup. */
async function populate(input: string) {
  const {decisions} = JSON.parse(await readFile(input,"utf8")) as {decisions:{placement:string; parse:{address?:string}; streetName?:string}[]};
  await mkdir(cacheDir,{recursive:true});
  let last = 0;
  for (const d of decisions) {
    if (d.placement!=="street_only" || !d.parse.address || !d.streetName) continue;
    const number = d.parse.address.replace(/^0+(?=\d)/,"");
    if (await cachedAddress(d.streetName,number)!==undefined) continue;
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,1100-(Date.now()-last))));
    const params = new URLSearchParams({format:"jsonv2",street:number+" "+d.streetName,city:"Αθήνα",countrycodes:"gr",
      addressdetails:"1",limit:"3",bounded:"1",viewbox:"23.715,37.990,23.740,37.965"});
    last = Date.now();
    const res = await fetch((process.env.ION_NOMINATIM_URL ?? "https://nominatim.openstreetmap.org/search")+"?"+params,{
      headers:{"User-Agent":"ion-athens-hackathon/1.0 (github.com/monkylome/ION-Athens)","Accept-Language":"el"},
      signal:AbortSignal.timeout(8000)});
    if (!res.ok) throw new Error("Address lookup stopped: HTTP "+res.status);
    const hits = await res.json() as {address?:{road?:string;house_number?:string};lon:string;lat:string}[];
    const exact = hits.filter(h=>h.address?.house_number===number && streetKey(h.address?.road ?? "")===streetKey(d.streetName!));
    const point = exact.length===1 ? [Number(exact[0]!.lon),Number(exact[0]!.lat)] : null;
    const path = file(d.streetName,number), tmp = path+"."+randomUUID();
    await writeFile(tmp,JSON.stringify(point)); await rename(tmp,path);
  }
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  await populate(process.argv[2]!).catch(e=>{console.error(String(e));process.exitCode=1;});
}

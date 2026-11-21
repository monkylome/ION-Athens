import { z } from "zod";
import { fetchJson } from "./http.ts";
import type { SourceAdapter } from "./types.ts";

const url = "https://api.open-meteo.com/v1/forecast?latitude=37.978&longitude=23.727&current=rain&hourly=rain&timeformat=unixtime&forecast_days=2";
const data = z.object({current:z.object({time:z.number(),rain:z.number().nonnegative()}),
  hourly:z.object({time:z.array(z.number()),rain:z.array(z.number().nonnegative().nullable())})});
export function parseWeather(raw: unknown) {
  const {current,hourly} = data.parse(raw);
  if (hourly.time.length !== hourly.rain.length) throw new Error("Mismatched weather series");
  const nextHours = hourly.time.flatMap((t,i)=>t>current.time && t<=current.time+3*3600 ?
    [{at:new Date(t*1000).toISOString(),rainMm:hourly.rain[i] ?? null}] : []);
  const speech = current.rain>0 ? "Βρέχει στην Αθήνα. Τα πεζοδρόμια μπορεί να γλιστρούν." :
    nextHours.some(h=>(h.rainMm ?? 0)>0) ? "Αναμένεται βροχή τις επόμενες ώρες." : "Δεν καταγράφεται βροχή στην Αθήνα.";
  return {at:new Date(current.time*1000).toISOString(), rainMm:current.rain,nextHours,speech};
}
export const weatherAdapter: SourceAdapter<ReturnType<typeof parseWeather>> = {
  meta:{id:"open-meteo",name:"Πρόγνωση Αθήνας",owner:"Open-Meteo",gives:"Τρέχουσα βροχή και τρίωρη πρόγνωση για το κέντρο της Αθήνας",
    kind:"live",data:"real",terms:"Free API for non-commercial use; attribution required.",termsUrl:"https://open-meteo.com/en/terms",termsQuoted:false,permission:"open licence",request:url},
  ttlMs:600000,timeoutMs:5000,
  async fetch(_,env) {return [parseWeather(await fetchJson(env,url,"Open-Meteo forecast"))];},
};

import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { Observation } from "../missions/missions.ts";
import { doors, facts, venues, type Place } from "./catalogue.ts";

const participant = z.string().regex(/^[a-zA-Z0-9_-]{8,64}$/);
const label = z.string().trim().min(1).max(100);
const segment = z.object({steps:z.number().int().min(0).max(500),metres:z.number().min(0).max(500),
  turn:z.enum(["straight","left","right","back"]),note:z.string().trim().min(1).max(180).optional()});
const input = z.object({participant,start:label,target:label,segments:z.array(segment).min(1).max(24)});
const directions = {straight:"ευθεία",left:"αριστερά",right:"δεξιά",back:"προς τα πίσω"};
function describe(t: z.infer<typeof input>) {
  return "Αφετηρία: " + t.start + ". Προορισμός: " + t.target + ". " + t.segments.map(s =>
    s.metres.toLocaleString("el-GR") + (s.metres === 1 ? " μέτρο " : " μέτρα ") + directions[s.turn] +
    " (" + s.steps + (s.steps === 1 ? " βήμα)" : " βήματα)") + (s.note ? ", " + s.note : "") + ".").join(" ");
}
type Trail = Omit<z.infer<typeof input>,"participant"> & {id:string;createdAt:string;confirmed:boolean;confirmedAt:string|null;speech:string};
export function venueApi(observations: () => Observation[], now: () => Date) {
  const app = new Hono();
  const records = new Map<string, {author:string;trail:Trail}[]>();
  const trails = (v: Place) => (records.get(v.id) ?? []).map(r => r.trail);
  const card = (v: Place) => ({...v, entrances:doors(v), facts:facts(v,observations()), trails:trails(v)});
  function arrival(v: Place, door?: Place) {
    const clauses = ["Φτάσατε στον προορισμό σας. " + v.name + "."];
    if (!door) clauses.push("Η ακριβής είσοδος δεν έχει χαρτογραφηθεί.");
    const known = facts(v,observations());
    const step = known.find(f => f.key === "step_count" && f.entranceId === (door?.id ?? null));
    if (step && (step.source === "citizens" ? step.value === "yes" : step.value === "0")) clauses.push("Υπάρχει είσοδος χωρίς σκαλιά.");
    if (known.some(f => f.key === "elevator" && f.value === "yes")) clauses.push("Υπάρχει ανελκυστήρας για το κοινό.");
    if (known.some(f => f.key === "toilets:wheelchair" && f.value === "yes")) clauses.push("Υπάρχει προσβάσιμη τουαλέτα.");
    const trail = trails(v).find(t => t.confirmed);
    clauses.push(trail?.speech ?? "Δεν έχει χαρτογραφηθεί ακόμα το εσωτερικό.");
    return {venueId:v.id,entranceId:door?.id ?? null,speech:clauses.join(" ")};
  }
  app.get("/",c => c.json({venues:venues.map(card)}));
  app.get("/:id",c => {
    const v = venues.find(v => v.id === c.req.param("id"));
    return v ? c.json(card(v)) : c.json({error:"venue_not_found"},404);
  });
  app.post("/:id/trails",async c => {
    const v = venues.find(v => v.id === c.req.param("id"));
    if (!v) return c.json({error:"venue_not_found"},404);
    const parsed = input.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({error:"invalid_trail"},400);
    const {participant:author,...data} = parsed.data;
    const trail: Trail = {...data,id:randomUUID(),createdAt:now().toISOString(),confirmed:false,confirmedAt:null,speech:describe(parsed.data)};
    const list = records.get(v.id) ?? [];
    list.push({author,trail}); records.set(v.id,list);
    return c.json(trail,201);
  });
  app.post("/:id/trails/:trailId/confirm",async c => {
    const record = records.get(c.req.param("id"))?.find(r => r.trail.id === c.req.param("trailId"));
    if (!record) return c.json({error:"trail_not_found"},404);
    const parsed = z.object({participant}).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({error:"invalid_participant"},400);
    if (record.author === parsed.data.participant) return c.json({error:"another_participant_required"},409);
    record.trail.confirmed = true;
    record.trail.confirmedAt ??= now().toISOString();
    return c.json(record.trail);
  });
  return {app,arrival};
}

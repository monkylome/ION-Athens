import { expect, it } from "vitest";
import { venues, facts, doors, entrance, venueMissions, matchVenue } from "./catalogue.ts";
import { venueApi } from "./trails.ts";

it("keeps an unknown entrance unknown and links the named National Theatre door", () => {
  const olympia = matchVenue("Θέλω να πάω στο θέατρο")!;
  expect(olympia.address).toBe("Ακαδημίας 59");
  expect(doors(olympia)).toHaveLength(0);
  expect(facts(olympia, []).find(f => f.key === "step_count")).toMatchObject({value:null,source:"unknown",confirmedAt:null});
  const national = venues.find(v => v.nameEn === "National Theatre")!;
  expect(entrance(national,"wheels",[])?.source).toBe("osm:node/2834295977");
  const missions = venueMissions();
  expect(new Set(missions.map(m => m.id)).size).toBe(missions.length);
});

it("reads a trail on arrival only after independent confirmation", async () => {
  const api = venueApi(() => [], () => new Date("2026-11-21T15:00:00Z"));
  const v = matchVenue("Ολύμπια")!;
  const post = (path:string, body:unknown) => api.app.request(path, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  const body = {participant:"test-person-a",start:"είσοδος",target:"ταμείο",segments:[{metres:10,steps:14,turn:"straight"}]};
  const path = "/" + v.id + "/trails";
  expect((await post(path,{...body,segments:[]})).status).toBe(400);
  const res = await post(path,body);
  expect(res.status).toBe(201);
  const trail = await res.json() as {id:string;speech:string};
  const confirm = path + "/" + trail.id + "/confirm";
  expect((await post(confirm,{participant:body.participant})).status).toBe(409);
  expect(api.arrival(v).speech).not.toContain("ταμείο");
  expect((await post(confirm,{participant:"test-person-b"})).status).toBe(200);
  expect(api.arrival(v).speech).toContain("10 μέτρα ευθεία (14 βήματα)");
  const publicCard = await (await api.app.request("/" + v.id)).text();
  expect(publicCard).not.toContain("test-person");
});

import { describe, expect, it } from "vitest";
import type { GraphEdge, PedestrianGraph } from "@ion/core";
import { parseDecision, activeUntil, streetKey } from "./decision-parser.ts";
import { placeDecision, streetIndex, decisionObstacles } from "./diavgeia.ts";
import { MissionBoard } from "../missions/missions.ts";

describe("short authored decision subjects", () => {
  it.each([
    ["Διακοπή στη δεξιά λωρίδα της οδού Δείγματος","lane"],
    ["Πλήρης διακοπή της κυκλοφορίας οχημάτων","closure"],
    ["Εργασίες με γερανό","works"], ["Εργασίες όψεων","works"],
    ["Εκδηλώσεις στο κέντρο","event"], ["Διέλευση πορείας","event"],
    ["Πεζοδρόμηση της οδού Α","pedestrian_zone"], ["Απόφαση 123","unknown"],
  ])("%s", (s,kind) => expect(parseDecision(s).kind).toBe(kind));
  it("reads number, paired dates and hour window", () => {
    const p = parseDecision("οδού Άλφα, στο ύψος του ο.α. 12, στις 3 και 5-03-2026, ώρες 08:30 έως 09:30");
    expect(p).toMatchObject({street:"αλφα",address:"12",dates:["2026-03-03","2026-03-05"],hours:[510,570]});
  });
  it("recognises a numbered address but refuses to place it without addresses", () => {
    const p = parseDecision("οδού Άλφα στο ύψος του αριθμού 18");
    expect(p.address).toBe("18"); expect(streetIndex(graph)(p)).toEqual([]);
  });
  it("handles recurring local hours through a DST change", () => {
    const p = parseDecision("διακοπή από 1-03-2026 έως 5-05-2026, κάθε Δευτέρα, ώρες 08:00 έως 10:00");
    expect(activeUntil(p,issued,new Date("2026-03-30T06:05Z"))).toBe("2026-03-30T07:00:00.000Z");
    expect(activeUntil(p,issued,new Date("2026-03-31T06:05Z"))).toBeNull();
  });
  it("uses the starting date for overnight hours", () => {
    const p = parseDecision("διακοπή στις 4/05/2026, ώρες 22:00 έως 05:00");
    expect(activeUntil(p,issued,new Date("2026-05-05T00:30Z"))).toBe("2026-05-05T02:00:00.000Z");
  });
  it("leaves an extension and an invalid date inactive", () => {
    for(const s of ["Παράταση έως 04-05-2026","Διακοπή στις 31/02/2026"]) expect(parseDecision(s).validSchedule).toBe(false);
  });
});
const issued = new Date("2026-02-01T08:00Z");
const now = new Date("2026-05-04T06:00Z");
function edge(id:string, name:string, from:string, to:string): GraphEdge {
  return {id,name,from,to,lengthM:10,kind:"footway",geometry:[[23,38],[23.001,38]]};
}
const graph: PedestrianGraph = {nodes:[],edges:[edge("a","Άλφα","1","2"),edge("b","Άλφα","2","3"),edge("c","Άλφα","3","4"),edge("x","Βήτα","2","5"),edge("y","Γάμμα","4","6")],
  meta:{bbox:[0,0,0,0],builtAt:"",source:"test",licence:"",attribution:"",nodeCount:6,edgeCount:5}};
const input = {ada:"test",authority:"Αρχή",issueDate:+issued,subject:"Διακοπή κυκλοφορίας οχημάτων της οδού Άλφα, μεταξύ των οδών Βήτα και Γάμμα, στις 04/05/2026"};
it("places only the named stretch", () => {
  expect(streetKey("της οδού Άλφα")).toBe("αλφα");
  expect(placeDecision(input,streetIndex(graph)).edges.map(e=>e.id)).toEqual(["b","c"]);
  expect(streetIndex(graph)(parseDecision(input.subject.replace("Γάμμα","Άγνωστη")))).toEqual([]);
});
it("defaults to a partial effect and requires explicit pedestrian closure for full", () => {
  const make = (s:string) => decisionObstacles(placeDecision({...input,subject:s},streetIndex(graph)),now);
  expect(make(input.subject)[0]).toMatchObject({blocks:"partial",synthetic:false,source:{kind:"open_data",ref:"test"}});
  expect(make(input.subject.replace("Διακοπή κυκλοφορίας οχημάτων","Πλήρης διακοπή κυκλοφορίας πεζών"))[0]?.blocks).toBe("full");
});
it.each(["yes","no"] as const)("applies two matching %s answers to the stretch only for the local day", answer => {
  const board = new MissionBoard(graph,{},()=>now);
  const obs = decisionObstacles(placeDecision(input,streetIndex(graph)),now);
  const missions = board.all(obs);
  expect(missions).toHaveLength(1);
  const id = missions[0]!.id;
  for (const who of ["citizen-one","citizen-two"]) expect(board.answer(id,who,answer,null,now,obs).ok).toBe(true);
  const changed = board.applyPavementAnswers(obs,now);
  expect(changed.map(o=>o.blocks)).toEqual(answer==="yes"?[]:["full","full"]);
  expect(board.applyPavementAnswers(obs,new Date("2026-05-05T10:00Z"))).toEqual(obs);
});

import { decisionHint } from "./diavgeia.ts";
import { upcomingStart } from "./decision-parser.ts";
const boxGraph: PedestrianGraph = {...graph,meta:{...graph.meta,bbox:[22.99,37.99,23.001,38.01]}};
const ix = streetIndex(boxGraph);
const address = {...input,subject:"Διακοπή στην οδό Άλφα, στο ύψος του αριθμού 9, στις 04/05/2026"};
it("keeps an unlocated number as a mission only, and confirms a nearby exact address", () => {
  const hint = placeDecision(address,ix);
  expect(hint).toMatchObject({inside:true,placement:"street_only",reason:"building_number_only"});
  expect(decisionObstacles(hint,now)).toEqual([]);
  expect(decisionHint(hint,now)).toHaveLength(1);
  expect(placeDecision(address,ix,[23,38.001]).placement).toBe("street_only");
  const precise = placeDecision(address,ix,[23,38.0001]);
  expect(precise.placement).toBe("address");
  expect(decisionObstacles(precise,now)).toHaveLength(1);
});
it("reports why a decision cannot be placed", () => {
  for (const [subject,reason] of [
    ["Διακοπή της οδού Ανύπαρκτης","outside_area"],["Κατωθι οδικών τμημάτων","several_streets"],
    ["Ρυθμίσεις 105","subject_too_vague"],["Οδός: λείπει το όνομα","parse_failed"],
  ]) expect(placeDecision({...input,subject:subject!},ix)).toMatchObject({reason,placement:"unplaced"});
});
it("uses a one-ended explicit stretch only when its continuation reaches the box boundary", () => {
  const base = "Διακοπή της οδού Άλφα, από την οδό Πρώτη έως την οδό Άγνωστη, στις 04/05/2026";
  const g = {...boxGraph,edges:[edge("aa","Άλφα","a","b"),edge("first","Πρώτη","a","x")]};
  expect(placeDecision({...input,subject:base},streetIndex(g))).toMatchObject({placement:"stretch",missingCrossStreets:["αγνωστη"]});
  expect(placeDecision({...input,subject:base.replace("από την οδό Πρώτη έως την οδό","μεταξύ των οδών Πρώτη και")},streetIndex(g)).placement).toBe("street_only");
});
it("lists the exact upcoming Athens start, capped at seven days", () => {
  const p = parseDecision("Έργα στις 04/05/2026, ώρες 08:00 έως 09:00");
  expect(upcomingStart(p,issued,new Date("2026-05-03T12:00Z"))).toBe("2026-05-04T05:00:00.000Z");
  expect(upcomingStart(p,issued,new Date("2026-04-20T12:00Z"))).toBeNull();
});
it("does not count an event or municipality name as a matched street", () => {
  expect(placeDecision({...input,subject:"Εορτασμός Άλφα στην πόλη"},ix).inside).toBe(false);
});

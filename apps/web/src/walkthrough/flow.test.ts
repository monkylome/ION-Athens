import { expect, it } from "vitest";
import { advance, venueId, venuePath, type Call, type State } from "./flow";

it("requests mapping and submits one vote before bringing in the second citizen", async () => {
  const votes: string[] = [];
  const requests: string[] = [];
  const call: Call = async <T>(path:string, body?:unknown) => {
    if (path === "/destination") return {understood:true,place:{id:venueId}} as T;
    if (path === venuePath) return {lng:23.7,lat:38,facts:[]} as T;
    if (path.endsWith("/requests")) { requests.push(path); return {} as T; }
    if (path.startsWith("/missions?")) return {missions:[{id:"test",venueId,key:"elevator",requested:true}]} as T;
    if (path.endsWith("/answer")) { votes.push((body as {participant:string}).participant); return {} as T; }
    throw Error(path);
  };
  let state: State = {step:0};
  const actors = ["requester","citizen-a","citizen-b"];
  for(let i=0;i<3;i++) state=await advance(state,call,actors);
  expect(requests).toHaveLength(1);
  expect(votes).toEqual(["citizen-a"]);
  expect(state.requested).toBe(true);
  await advance(state,call,actors);
  expect(votes).toEqual(["citizen-a","citizen-a","citizen-b"]);
});

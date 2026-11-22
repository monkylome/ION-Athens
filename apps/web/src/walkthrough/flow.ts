import type { Route } from "@ion/core";

export const venueId = "community_centre-x-w217627849";
export const venuePath = "/venues/" + venueId;
export type Card = {name:string; lng:number; lat:number; requestCount:number; facts:{key:string; question:string; value:string|null; source:string; entranceId:string|null}[]};
type Mission = { id:string; key:string; venueId:string; requested?:boolean; answers:{yes:number;no:number} };
export type State = {step:number; card?:Card; route?:Route; speech?:string; requested?:boolean};
export type Call = <T>(path:string, body?:unknown) => Promise<T>;
export const labels = ["Αναζήτηση χώρου", "Αίτημα χαρτογράφησης", "Πρώτη παρατήρηση", "Επιβεβαίωση", "Διαδρομή", "Άφιξη"];

export async function advance(state:State, call:Call, actors:string[]):Promise<State> {
  const step = state.step + 1;
  const read = () => call<Card>(venuePath);
  if (step === 1) {
    const destination = await call<{understood:boolean;place?:{id:string}}>("/destination",{text:"Θέλω να πάω στο Σεράφειο."});
    if (!destination.understood || destination.place?.id !== venueId) throw Error("Ο προορισμός δεν ταυτοποιήθηκε.");
    return {step,card:await read()};
  }
  const card = state.card!;
  if (step === 2) {
    const {requestCount} = await call<{requestCount:number}>(venuePath+"/requests",{participant:actors[0]});
    return {...state,step,card:{...card,requestCount}};
  }
  if (step === 3 || step === 4) {
    const {missions} = await call<{missions:Mission[]}>(`/missions?lng=${card.lng}&lat=${card.lat}&radius=120&limit=100`);
    const open = missions.filter(m=>m.venueId===venueId);
    const selected = step === 3 ? open.filter(m=>m.key==="elevator") : open;
    const vote = async (m:Mission, participant:string) => {
      try { await call("/demo/missions/"+encodeURIComponent(m.id)+"/answer",{participant,answer:m.key==="guide_dog"?"no":"yes"}); }
      catch (error) { if (!(error instanceof Error) || !/ήδη/.test(error.message)) throw error; }
    };
    for (const mission of selected) {
      await vote(mission,actors[1]!);
      if (step === 4) await vote(mission,actors[2]!);
    }
    return {...state,step,card:await read(),requested:open.some(m=>m.requested)};
  }
  if (step === 5) {
    const {route,arrival} = await call<{route:Route;arrival?:{speech:string}}>("/route",{
      from:{lng:23.7105,lat:37.9746},to:{lng:card.lng,lat:card.lat},venueId,profile:"voice",
    });
    if (!arrival?.speech) throw Error("Η οδηγία άφιξης δεν είναι διαθέσιμη.");
    return {...state,step,card:await read(),route,speech:arrival.speech};
  }
  return {...state,step};
}

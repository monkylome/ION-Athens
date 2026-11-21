const {baseURL,button,go}=require("./runtime.cjs");
const {randomUUID}=require("node:crypto");

// Use the public demo APIs for a second witness. The recorded player answers in the UI.
async function gameFlow(p, inspect, recording=false) {
  const witness="backup-"+randomUUID();
  async function api(path, data) {
    const response=await p.request.fetch(baseURL+"/api/"+path,{method:data?"POST":"GET",data});
    if (!response.ok()) throw Error(path+" returned HTTP "+response.status());
    return response.json();
  }
  const preset=encodeURIComponent(process.env.ION_DEMO_PRESET || "acropolis");
  const loop=await api("demo/loop?preset="+preset);
  const nearby=async ([lng,lat])=>(await api("missions?lng="+lng+"&lat="+lat+"&radius=5000&limit=100")).missions;
  const crossing=(await nearby(loop.crossing.position)).find(m=>m.id===loop.crossing.id && m.answers.no===0);
  const venues=await nearby([loop.destination.lng,loop.destination.lat]);
  const venue=venues.find(m=>m.id===loop.venueMissionId) ?? venues.find(m=>m.type==="venue_check" && m.venueId===loop.destination.id);
  if (!crossing || !venue) throw Error("Open crossing and venue missions required. Start a fresh rehearsal API.");
  const answerPath=id=>"demo/missions/"+encodeURIComponent(id)+"/answer";
  if (!crossing.answers.yes) await api(answerPath(crossing.id),{participant:witness,answer:"yes"});
  const [lng,lat]=loop.obstacle.position;
  const first=await api("reports?rehearsal=1",{lng,lat,category:"sidewalk",text:"Επίδειξη ION · προσωρινή αναφορά πρόβας"});
  try {
    const obstacle=(await nearby([lng,lat])).find(m=>m.id==="obstacle_check:"+first.report.id);
    if (!obstacle) throw Error("The rehearsal report has no confirmation mission.");
    for(const [i,m] of [crossing,obstacle,venue].entries()) {
      await go(p,"/play?demo=1&loop="+preset+"&fake="+m.position.join(",")+(recording?"&backup=1":""));
      await p.waitForFunction(()=>document.querySelector(".pl-progress__figure")?.textContent.includes("/"));
      await button(p,"Μενού").click();
      await button(p,/Κοντά σας/).click();
      await p.locator('[data-mission-id="'+m.id+'"]').click();
      await button(p,"Δείτε το με την κάμερα").click();
      await p.waitForFunction(()=>document.querySelector(".pl-cam video")?.readyState>=2);
      await inspect(p,"encounter "+(i+1));
      const result=p.waitForResponse(r=>r.url().endsWith("/"+encodeURIComponent(m.id)+"/answer") && r.request().method()==="POST");
      await p.locator(".pl-answer--yes").click();
      if (!(await result).ok()) throw Error("Mission answer failed for "+m.id);
      await p.locator(".pl-cam__stamp").waitFor();
      await inspect(p,"stamp "+(i+1));
      if(i===2){
        await p.getByRole("button",{name:/^(Συνέχεια|Πίσω στον χάρτη)$/}).click();
        const level=p.getByRole("dialog",{name:"Νέο επίπεδο"});
        const ticket=p.getByRole("dialog",{name:"Νέο προνόμιο"});
        await level.or(ticket).waitFor();
        if(await level.isVisible()) await button(level,"Συνέχεια").click();
        await ticket.waitFor();
        await inspect(p,"ticket");
      }
    }
    if (!venue.answers.yes) await api(answerPath(venue.id),{participant:witness,answer:"yes"});
  } finally {
    await api("demo/resolve/"+encodeURIComponent(first.report.id),{});
  }
}
module.exports={gameFlow};

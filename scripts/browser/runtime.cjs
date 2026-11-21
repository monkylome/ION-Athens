const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createRequire } = require("node:module");
const webRequire = createRequire(path.resolve(__dirname, "../../apps/web/package.json"));
const cache = path.join(process.env.npm_config_cache || path.join(os.homedir(), ".npm"), "_npx");

function playwright() {
  const locations = [process.env.ION_PLAYWRIGHT, "playwright-core"];
  if (fs.existsSync(cache)) {
    for (const entry of fs.readdirSync(cache)) locations.push(path.join(cache, entry, "node_modules/playwright-core"));
  }
  for (const name of locations.filter(Boolean)) {
    try { return webRequire(name); } catch (e) { if (e.code !== "MODULE_NOT_FOUND") throw e; }
  }
  throw Error("Point ION_PLAYWRIGHT at an installed playwright-core package.");
}
async function launch() {
  const { chromium } = playwright();
  const executablePath = [process.env.ION_CHROMIUM, chromium.executablePath(), "/usr/bin/chromium",
    "/usr/bin/google-chrome", "/opt/brave.com/brave/brave"].find(p => p && fs.existsSync(p));
  if (!executablePath) throw Error("Set ION_CHROMIUM to an installed Chromium executable.");
  return chromium.launch({executablePath, args:["--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader",
    "--use-fake-device-for-media-stream","--use-fake-ui-for-media-stream"]});
}
const baseURL = new URL(process.argv[2] || process.env.ION_WEB_URL || "http://localhost:5173").origin;
const phone = {width:412,height:915}, stage = {width:1600,height:900};
const button = (p,name) => p.getByRole("button", {name,exact:typeof name==="string"});
async function go(p, pathname) {
  await p.goto(new URL(pathname,baseURL).href, {waitUntil:"domcontentloaded"});
  await p.locator("#root > *").first().waitFor();
  await p.evaluate(() => document.fonts.ready);
}
async function stageFlow(p, inspect, recording=false, presenter=null, inspectPhone=async()=>{}) {
  const browser=p.context().browser();
  const options={viewport:phone,permissions:["geolocation"],geolocation:{longitude:23.70654,latitude:37.97423,accuracy:12}};
  const first=presenter ? presenter.context() : await browser.newContext(options);
  const second=await browser.newContext({...options,geolocation:{longitude:23.70632,latitude:37.97340,accuracy:12}});
  const player=presenter ?? await first.newPage(), witness=await second.newPage();
  const suffix=recording?"&backup=1":"";
  const preset=process.env.ION_DEMO_PRESET ?? "acropolis";
  const key=k=>p.keyboard.press(k);
  const get=async path=>(await p.request.get(baseURL+"/api/"+path)).json();
  const begin=Date.now();
  const mark=(name,detail="")=>console.log("Act",((Date.now()-begin)/1000).toFixed(1),name,detail);
  async function openMission(tab,id) {
    await button(tab,"Μενού").click(); await button(tab,/Κοντά σας/).click();
    await tab.locator('[data-mission-id="'+id+'"]').click();
    await tab.locator(".pl-card__question").waitFor();
  }
  async function answer(tab) {
    const result=tab.waitForResponse(r=>r.request().method()==="POST" && r.url().endsWith("/answer"));
    await tab.locator(".pl-answer--yes").click();
    const response=await result;
    if (!response.ok()) throw Error("Answer refused: "+response.status());
  }
  let reportId;
  try {
    await first.grantPermissions(["geolocation"]);
    await first.setGeolocation(options.geolocation);
    const loopQuery = process.env.ION_DEMO_PRESET ? "&loop="+encodeURIComponent(preset) : "";
    await go(p,"/stage?tiles=off&voice=off"+loopQuery+suffix);
    await p.waitForFunction(()=>!!window.__ionScenario?.getState().loop);
    const loop=await p.evaluate(()=>window.__ionScenario.getState().loop);
    const card=await get("venues/community_centre-x-w217627849");
    const missions=await get("missions?lng="+card.lng+"&lat="+card.lat+"&radius=120&limit=100");
    const hall=missions.missions.find(m=>m.venueId===card.id && !m.answers.yes && !m.answers.no);
    if (!hall) throw Error("No unanswered Serafeio question. Rewind the rehearsal.");
    await Promise.all([go(player,"/play?loop="+preset+suffix),go(witness,"/play?loop="+preset)]);
    await openMission(player,hall.id); await openMission(witness,hall.id);
    const count=card.facts.filter(f=>f.value!==null).length;
    await inspectPhone(player,"hall"); mark("hall",hall.question);
    await answer(player); await answer(witness);
    await player.locator(".pl-venue__count").filter({hasText:(count+1)+" από "}).waitFor();
    await player.getByText("Επιβεβαιώθηκε",{exact:true}).first().waitFor();
    await inspectPhone(player,"hall confirmed"); mark("hall confirmed",count+" → "+(count+1));
    await key("a"); await p.locator(".pitch-frame").waitFor(); await inspect(p,"opening"); mark("city quotation"); await key("Enter");
    const [lng,lat]=loop.obstacle.position;
    const ledger=await get("demo/rewind-reports");
    const nearby=await get("missions?lng="+lng+"&lat="+lat+"&radius=100&limit=100");
    const owned=nearby.missions.find(m=>m.type==="obstacle_check" && m.edgeIds.includes(loop.obstacle.edgeId) && ledger.ids.includes(m.id.slice(15)));
    if (owned) reportId=owned.id.slice(15);
    else {
      const created=await p.request.post(baseURL+"/api/reports?rehearsal=1",{data:{lng,lat,category:"sidewalk",text:"Επίδειξη ION · πρώτη αναφορά εμποδίου"}});
      if (!created.ok()) throw Error("Unable to seed the rehearsal report");
      reportId=(await created.json()).report.id;
    }
    await button(player,"Χάρτης").click();
    await button(player,"Μενού").click(); await button(player,"Στη διαδρομή της επίδειξης").click();
    await player.waitForURL(/demo=1/);
    await openMission(player,"obstacle_check:"+reportId);
    await inspectPhone(player,"obstacle"); await answer(player); mark("citizen confirmed obstacle");
    await button(player,"Χάρτης").click(); await button(player,"Μενού").click();
    await button(player,"Πίσω στη θέση μου").click(); await player.waitForURL(u=>!u.searchParams.has("demo"));
    if (presenter && recording) await presenter.close();
    await p.waitForFunction(edge=>window.__ionScenario.getState().obstacles.some(o=>o.closes && o.obstacle.edgeId===edge),loop.obstacle.edgeId);
    await key("Enter"); await p.waitForFunction(()=>window.__ionScenario.getState().phase==="destination");
    await key("Enter"); await p.waitForFunction(()=>!!window.__ionScenario.getState().walker);
    await inspect(p,"walking"); mark("walking");
    await p.waitForFunction(()=>window.__ionScenario.getState().caption?.kind==="obstacle",null,{timeout:90000});
    mark("warning",await p.evaluate(()=>window.__ionScenario.getState().caption.text)); await inspect(p,"dark");
    await p.waitForFunction(()=>window.__ionScenario.getState().phase==="walking_new"); await inspect(p,"detour");
    await p.locator(".venue-reveal").waitFor({timeout:90000});
    await p.waitForFunction(()=>window.__ionScenario.getState().caption?.text.includes("Φτάσατε"));
    mark("arrival",await p.evaluate(()=>window.__ionScenario.getState().caption.text)); await inspect(p,"arrival");
    await key("s"); await p.getByLabel("Πηγές δεδομένων").waitFor(); await inspect(p,"sources"); mark("sources"); await key("Escape");
    if (!recording) {
      await key("c"); await p.waitForFunction(()=>document.querySelector(".compare footer p")?.textContent.includes("μέτρα"));
      await inspect(p,"comparison"); await key("Escape");
    }
    await p.waitForFunction(()=>window.__ionScenario.getState().caption?.done);
    await key("Enter"); await p.getByText("Ἰών. Αυτός που πηγαίνει.").waitFor(); await inspect(p,"closing"); mark("closing");
  } finally {
    await second.close(); if (!presenter) await first.close();
    if (reportId && !(await p.request.post(baseURL+"/api/demo/resolve/"+reportId)).ok()) throw Error("Failed to resolve rehearsal report "+reportId);
  }
}
module.exports = {launch,webRequire,baseURL,phone,stage,button,go,stageFlow};

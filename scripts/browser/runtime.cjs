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
async function stageFlow(p, inspect, recording=false) {
  const key = k => p.keyboard.press(k);
  const state = phase => p.waitForFunction(v=>window.__ionScenario?.getState().phase===v,phase,{timeout:90000});
  let reportId;
  try {
    await go(p, "/stage?citizen=scripted&tiles=off&voice=off" + (recording?"&backup=1":""));
    await p.waitForFunction(()=>!!window.__ionScenario?.getState().loop);
    if (!recording) {
      await key("c"); await p.waitForFunction(()=>document.querySelector(".compare footer p")?.textContent.includes("μέτρα"));
      await inspect(p,"comparison"); await key("Escape");
      await key("s"); await p.getByLabel("Πηγές δεδομένων").waitFor(); await inspect(p,"sources"); await key("Escape");
    }
    await key("a"); await p.locator(".pitch-frame").waitFor(); await inspect(p,"opening"); await key("Enter");
    await key("Enter"); await state("destination"); await key("Enter"); await state("walking");
    await inspect(p,"walking");
    await key("1");
    await p.waitForFunction(()=>window.__ionScenario.getState().obstacles.some(o=>o.createdHere));
    reportId = await p.evaluate(()=>window.__ionScenario.getState().obstacles.find(o=>o.createdHere).reportId);
    await p.waitForFunction(()=>window.__ionScenario.getState().waiting);
    await key("2");
    await p.locator('[data-moment="dark"]').waitFor(); await inspect(p,"dark");
    await p.locator(".venue-reveal").waitFor({timeout:90000}); await inspect(p,"arrival");
    await p.waitForFunction(()=>window.__ionScenario.getState().caption?.done);
    await key("Enter"); await p.getByText("Απόψε τον έγραψε η πόλη.").waitFor(); await inspect(p,"closing");
  } finally {
    if (reportId) {
      const result = await p.request.post(baseURL+"/api/demo/resolve/"+encodeURIComponent(reportId));
      if (!result.ok()) throw Error("Could not resolve rehearsal report "+reportId);
    }
  }
}
module.exports = {launch,webRequire,baseURL,phone,stage,button,go,stageFlow};

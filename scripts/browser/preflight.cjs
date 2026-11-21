const {launch,go} = require("./runtime.cjs");
(async () => {
  const browser = await launch();
  try {
    for (const [path, selector] of [
      ["/stage?citizen=live&tiles=off&voice=off", ".stage-canvas"],
      ["/play?demo=1", ".pl-action"],
      ["/play/scan", ".scan__view"],
      ["/about", "main h1"],
    ]) {
      const p = await browser.newPage();
      try {
        p.setDefaultTimeout(8000);
        const loop = path.startsWith("/stage") ? p.waitForResponse(r =>
          new URL(r.url()).pathname === "/api/demo/loop" && r.ok(), {timeout:10000}) : null;
        await Promise.all([go(p,path), loop]);

        await p.locator(selector).first().waitFor({state:"attached"});
        console.log("OK · browser ·",path);
      } catch (error) {
        console.log("FAIL · browser ·",path,error.message.split("\n")[0]);
        process.exitCode = 1;
      } finally { await p.close(); }
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error.message); process.exitCode=1; });

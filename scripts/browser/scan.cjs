const {readFileSync} = require("node:fs");
const path = require("node:path");
const {go, button} = require("./runtime.cjs");

// Feed a local test photograph through a video track. The scan still captures a
// frame, encodes it, and calls the real model unless the caller supplies fixtures.
async function photoCamera(page, photo) {
  const jpeg = readFileSync(photo).toString("base64");
  await page.addInitScript(encoded => {
    const media = navigator.mediaDevices;
    const getMedia = media.getUserMedia.bind(media);
    media.getUserMedia = async constraints => {
      if (!constraints.video || constraints.audio) return getMedia(constraints);
      const img = new Image();
      img.src = "data:image/jpeg;base64," + encoded;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      const draw = () => ctx.drawImage(img, 0, 0);
      draw();
      const stream = canvas.captureStream(5);
      const timer = setInterval(draw, 200);
      const track = stream.getVideoTracks()[0];
      const stop = track.stop.bind(track);
      track.stop = () => { clearInterval(timer); stop(); };
      return stream;
    };
  }, jpeg);
}

async function scanFlow(page, inspect, recording=false, options={}) {
  const position = options.position ?? [23.722,37.981];
  if (!options.fixture) {
    await photoCamera(page, process.env.ION_SCAN_PHOTO || path.resolve(__dirname,
      "../../data-local/vision/testset/set/t02_1024.jpg"));
  }
  await go(page, "/play?demo=1&fake="+position.join(",")+(recording?"&backup=1":""));
  await page.getByRole("link",{name:"Σάρωση",exact:true}).click();
  await page.waitForFunction(()=>document.querySelector("video")?.readyState>=2);
  await button(page,"Σαρώστε").click();
  await page.locator(".scan__tile[data-state=open]").waitFor({timeout:25000});
  await inspect(page,"proposals");
  const first=page.locator(".scan__tile[data-state=open]");
  if (await first.getAttribute("data-discovery")!=="true") throw Error("Test frame matched a mission instead of a discovery");
  const response=page.waitForResponse(r=>r.url().endsWith("/api/vision/confirm") && r.request().method()==="POST");
  await button(first,"Σωστό").click();
  const receipt=await (await response).json();
  await page.locator(".scan__tile[data-state=done]").waitFor();
  await inspect(page,"confirmed");
  if(options.describe){
    await button(page,"Για όποιον δεν βλέπει").click();
    await button(page,"Τι υπάρχει μπροστά μου;").click();
    await page.locator(".scan__speech").waitFor({timeout:25000});
    await inspect(page,"describe");
  }
  await page.getByRole("link",{name:"Πίσω στον χάρτη"}).click();
  await button(page,"Μενού").click();
  await button(page,/Το άλμπουμ μου/).click();
  await page.locator(".pl-tile").filter({hasText:receipt.label}).first().waitFor();
  await inspect(page,"discoveries");
  return receipt;
}

module.exports={scanFlow};

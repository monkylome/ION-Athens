/**
 * "Inference later": runs the current model again over the frames citizens chose to donate
 * and prints what changed. Run through scripts/vision-reprocess. Reads only data-local/vision/kept.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OllamaModel } from "./model.ts";
import { VisionService } from "./service.ts";

const dir = process.env["VISION_KEPT_DIR"] ?? fileURLToPath(new URL("../../../../data-local/vision/kept", import.meta.url));
const url = process.env["VISION_URL"] ?? "http://127.0.0.1:11435";
const name = process.env["VISION_MODEL"] ?? "qwen3-vl:4b-instruct";
const write = process.argv.includes("--write");
const model = new OllamaModel(url, name);

const service = new VisionService({
  model, licence: "", now: () => new Date(), areaOf: () => "", missionsNear: () => [],
  answerMission: async () => ({ ok: false, status: 500, code: "unused", message: "" }),
  award: () => { throw new Error("unused"); }, profile: () => { throw new Error("unused"); }, announce: () => undefined, keptDir: dir,
});

const frames = (() => { try { return readdirSync(dir).filter((f) => f.endsWith(".jpg")).sort(); } catch { return []; } })();
if (!frames.length) {
  console.log(`No kept frames in ${dir}.`);
  process.exit(0);
}
if (!(await model.ping(AbortSignal.timeout(3000)))) {
  console.error(`The model ${name} does not answer at ${url}. Start it with scripts/vision-start.`);
  process.exit(1);
}

const summary = (list: Array<{ kind: string; text?: string }> | null | undefined) => (list ?? []).map((p) => (p.text ? `${p.kind}:${p.text}` : p.kind)).sort();
let changed = 0, same = 0, failed = 0, first = 0;
for (const jpg of frames) {
  const jsonPath = join(dir, jpg.replace(/\.jpg$/, ".json"));
  let meta: Record<string, unknown> = {};
  try { meta = JSON.parse(readFileSync(jsonPath, "utf8")) as Record<string, unknown>; } catch { /* a frame without its note */ }
  const before = meta["proposals"] as Array<{ kind: string; text?: string }> | null | undefined;
  const result = await service.detect(readFileSync(join(dir, jpg)).toString("base64"));
  if (!result.ok) { failed++; console.log(`${jpg}  FAILED ${result.code}: ${result.message}`); continue; }
  const after = summary(result.proposals);
  if (before === null || before === undefined) {
    first++;
    console.log(`${jpg}  first analysis (it was queued): ${after.join(", ") || "nothing"}`);
  } else {
    const was = summary(before);
    const added = after.filter((k) => !was.includes(k)), removed = was.filter((k) => !after.includes(k));
    if (!added.length && !removed.length) { same++; console.log(`${jpg}  unchanged: ${after.join(", ") || "nothing"}`); }
    else { changed++; console.log(`${jpg}  changed: +[${added.join(", ")}] -[${removed.join(", ")}]`); }
  }
  if (write) writeFileSync(jsonPath, JSON.stringify({ ...meta, proposals: result.proposals, model: name, reprocessedAt: new Date().toISOString() }, null, 1));
}
console.log(`\n${frames.length} frames with ${name}: ${first} analysed for the first time, ${changed} changed, ${same} unchanged, ${failed} failed.${write ? " Notes updated." : " Nothing written (use --write)."}`);

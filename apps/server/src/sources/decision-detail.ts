import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fetchJson } from "./http.ts";
import type { FetchEnv } from "./types.ts";
import { parseDecision } from "./decision-parser.ts";

const run = promisify(execFile);
/** Supplement one otherwise opaque result per feed and refresh. Preserve the official subject. */
export async function decisionDetail(ada: string, env: FetchEnv): Promise<string | undefined> {
  const id = encodeURIComponent(ada);
  const detail = await fetchJson(env, `https://diavgeia.gov.gr/opendata/decisions/${id}.json`, "Diavgeia detail");
  if (detail && typeof detail === "object" && "subject" in detail && typeof detail.subject === "string" && parseDecision(detail.subject).street) return detail.subject;
  await run("pdftotext", ["-v"], {timeout:1000});
  const res = await env.fetch("https://diavgeia.gov.gr/doc/"+id, {signal: AbortSignal.timeout(env.timeoutMs)});
  if (!res.ok || !res.body) return;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const {done,value} = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 5_000_000) { await reader.cancel(); return; }
    chunks.push(value);
  }
  const dir = await mkdtemp(join(tmpdir(),"ion-decision-"));
  try {
    const path = join(dir,"decision.pdf");
    await writeFile(path,Buffer.concat(chunks));
    const {stdout} = await run("pdftotext",["-layout",path,"-"],{timeout:4000,maxBuffer:500000});
    // A numbered operative clause gives review context. Multi-clause PDF conditions
    // require human interpretation before a PDF-only decision can affect routing.
    return stdout.match(/Αποφασίζουμε\s+([\s\S]{20,2500})/iu)?.[1]?.replace(/\s+/g," ").trim();
  } finally { await rm(dir,{recursive:true,force:true}); }
}

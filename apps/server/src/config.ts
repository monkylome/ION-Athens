/** Server settings, all from the environment. The API key is read here and handed only to the sandbox client. */
import { fileURLToPath } from "node:url";

export interface Config {
  port: number;
  sandboxBaseUrl: string | undefined;
  sandboxKey: string | undefined;
  graphPath: string;
  pollMs: number;
  /** Extra origins allowed by CORS, besides localhost on any port. */
  corsOrigins: string[];
  demoEnabled: boolean;
  useLlm: boolean;
  reportTtlHours: number | undefined;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const num = (v: string | undefined, fallback: number) => {
    const n = Number(v);
    return v !== undefined && v !== "" && Number.isFinite(n) ? n : fallback;
  };
  return {
    port: num(env["PORT"], 8787),
    sandboxBaseUrl: env["SANDBOX"] || undefined,
    sandboxKey: env["SANDBOX_KEY"] || undefined,
    graphPath: env["ION_GRAPH_PATH"] || fileURLToPath(new URL("../../../data/athens-centre.graph.json", import.meta.url)),
    // Never faster than 2 s: reports and projects together must stay far below 100 calls a minute.
    pollMs: Math.max(2000, num(env["ION_POLL_MS"], 5000)),
    corsOrigins: (env["ION_CORS_ORIGINS"] ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    demoEnabled: env["ION_DEMO"] !== "off",
    useLlm: env["ION_LLM"] !== "off",
    reportTtlHours: env["ION_REPORT_TTL_HOURS"] ? num(env["ION_REPORT_TTL_HOURS"], 12) : undefined,
  };
}

/** Starts the ION Athens server. Run with `npm run dev --workspace @ion/server`. */
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { readConfig } from "./config.ts";
import { EdgeIndex } from "./routing/edge-index.ts";
import { createRouting, loadGraph } from "./routing/index.ts";
import { SandboxClient } from "./sandbox/client.ts";

const config = readConfig();
const log = (line: string) => console.log(`[ion-server] ${line}`);

const { graph, loaded, problem } = loadGraph(config.graphPath);
log(loaded ? `graph loaded: ${graph.nodes.length} nodes, ${graph.edges.length} edges` : `no graph (${problem}); obstacles cannot be matched to streets yet`);

const client = new SandboxClient({ baseUrl: config.sandboxBaseUrl, apiKey: config.sandboxKey });
if (!client.configured) log("SANDBOX or SANDBOX_KEY is not set: every sandbox call will fail with not_configured");

const routing = createRouting(graph);
const { app, obstacles } = createApp({
  client,
  routing,
  edges: { nearestEdge: (p, max) => routing.nearestEdge(p, max), edgesInBBox: (() => { const index = new EdgeIndex(graph); return (box) => index.edgesInBBox(box); })() },
  graphLoaded: loaded,
  pollMs: config.pollMs,
  corsOrigins: config.corsOrigins,
  demoEnabled: config.demoEnabled,
  useLlm: config.useLlm,
  ...(config.reportTtlHours !== undefined ? { mapping: { reportTtlHours: config.reportTtlHours } } : {}),
  log,
});

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  log(`listening on http://localhost:${info.port} (routing: ${routing.engine}, demo control: ${config.demoEnabled ? "on" : "off"})`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    obstacles.stop();
    server.close();
    process.exit(0);
  });
}

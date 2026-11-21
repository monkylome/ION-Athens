/** The HTTP side of the camera feature, mounted at /api/vision. */
import { fileURLToPath } from "node:url";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { OllamaModel, type VisionModel } from "./model.ts";
import { type VisionDeps, VisionService } from "./service.ts";
import { KINDS, type Kind } from "./vocab.ts";

export interface VisionConfig extends Omit<VisionDeps, "model" | "licence" | "keptDir"> {
  /** Environment: VISION_URL and VISION_MODEL. Without both the endpoints answer 503. */
  env?: Record<string, string | undefined>;
  /** Tests pass a fake model. */
  model?: VisionModel | null;
  keptDir?: string;
}

const NOT_CONFIGURED = "Η ανάλυση εικόνας δεν είναι ενεργή σε αυτόν τον διακομιστή. Μπορείτε να συνεχίσετε με τις συνηθισμένες αποστολές.";
const ID = /^[A-Za-z0-9_-]{8,64}$/;
const lng = z.number().min(-180).max(180);
const lat = z.number().min(-90).max(90);
const participant = z.string().regex(ID);

const observeSchema = z.object({
  image: z.string().min(100),
  lng, lat,
  heading: z.number().min(0).max(360).optional(),
  participant,
  purpose: z.enum(["map", "describe"]),
  keep: z.boolean().optional(),
});
const confirmSchema = z.object({
  participant,
  proposal: z.object({
    kind: z.enum(KINDS as unknown as [Kind, ...Kind[]]),
    text: z.string().max(100).optional(),
    mission: z.object({ id: z.string().max(100) }).partial().optional(),
  }),
  lng, lat,
  missionId: z.string().max(100).optional(),
});

/** Known weights, so the licence in the status is a fact and not a guess. Anything else: set VISION_LICENCE. */
const LICENCES: Array<[RegExp, string]> = [
  [/^qwen3-vl|^qwen2\.5vl:(?!3b|72b)/i, "Apache-2.0"],
  [/^qwen2\.5vl:3b|^qwen2\.5vl:72b/i, "Qwen Research Licence (not Apache-2.0)"],
  [/^gemma3/i, "Gemma Terms of Use"],
  [/^minicpm-v/i, "Apache-2.0 code, MiniCPM Model License for weights"],
  [/^moondream/i, "Apache-2.0"],
  [/^llama3\.2-vision/i, "Llama 3.2 Community Licence"],
];

export function createVision(cfg: VisionConfig) {
  const env = cfg.env ?? {};
  const url = env["VISION_URL"]?.trim();
  const name = env["VISION_MODEL"]?.trim();
  const model = cfg.model !== undefined ? cfg.model : url && name ? new OllamaModel(url, name) : null;
  const licence = env["VISION_LICENCE"]?.trim() || LICENCES.find(([re]) => re.test(name ?? model?.name ?? ""))?.[1] || "άγνωστη, ελέγξτε τα βάρη του μοντέλου";
  const keptDir = cfg.keptDir ?? fileURLToPath(new URL("../../../../data-local/vision/kept", import.meta.url));
  const service = new VisionService({ ...cfg, model, licence, keptDir });
  const router = new Hono();

  const error = (c: Context, status: number, code: string, message: string) => c.json({ error: { code, message } }, status as 400);
  const parse = async <T>(c: Context, schema: z.ZodType<T, z.ZodTypeDef, unknown>, maxChars: number) => {
    if (Number(c.req.header("content-length")) > maxChars) return { ok: false as const, res: error(c, 413, "too_large", "Η φωτογραφία είναι πολύ μεγάλη. Δοκιμάστε ξανά.") };
    let text = "";
    try { text = await c.req.text(); } catch { /* empty */ }
    if (text.length > maxChars) return { ok: false as const, res: error(c, 413, "too_large", "Η φωτογραφία είναι πολύ μεγάλη. Δοκιμάστε ξανά.") };
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { return { ok: false as const, res: error(c, 400, "invalid_json", "Το σώμα του αιτήματος πρέπει να είναι JSON.") }; }
    const r = schema.safeParse(raw);
    if (r.success) return { ok: true as const, data: r.data };
    return { ok: false as const, res: error(c, 400, "invalid_request", r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")) };
  };

  router.get("/status", async (c) => c.json(await service.status()));
  router.get("/discoveries", (c) => c.json({ discoveries: service.discoveries() }));

  router.post("/observe", async (c) => {
    const b = await parse(c, observeSchema, Math.ceil((service.opts.maxImageBytes * 4) / 3) + 4096);
    if (!b.ok) return b.res;
    const { purpose, keep, heading } = b.data;
    const at: [number, number] = [b.data.lng, b.data.lat];
    if (!service.configured && !keep) return error(c, 503, "not_configured", NOT_CONFIGURED);
    const image = service.checkImage(b.data.image);
    if (!image.ok) return error(c, image.status, image.code, image.message);

    if (!service.configured) {
      // No model at all, but the citizen chose to donate the frame: it waits for the day a model is there.
      return service.keep(image.bytes, { at, heading, proposals: null, model: null })
        ? c.json({ purpose, queued: true, kept: true, message: "Η φωτογραφία κρατήθηκε και θα αναλυθεί αργότερα." }, 202)
        : error(c, 503, "not_configured", NOT_CONFIGURED);
    }
    const found = await service.detect(image.b64);
    if (!found.ok) {
      if (keep && (found.code === "model_unavailable" || found.code === "timeout")) {
        if (service.keep(image.bytes, { at, heading, proposals: null, model: model?.name ?? null })) {
          return c.json({ purpose, queued: true, kept: true, message: "Η φωτογραφία κρατήθηκε και θα αναλυθεί αργότερα." }, 202);
        }
      }
      return error(c, found.status, found.code, found.message);
    }
    const kept = keep === true && service.keep(image.bytes, { at, heading, proposals: found.proposals, model: model?.name ?? null });
    const base = { purpose, model: model?.name, ms: found.ms, kept };
    if (purpose === "describe") return c.json({ ...base, speech: service.speech(found.proposals) });
    return c.json({ ...base, proposals: service.attach(found.proposals, at) });
  });

  router.post("/confirm", async (c) => {
    if (!service.configured) return error(c, 503, "not_configured", NOT_CONFIGURED);
    const b = await parse(c, confirmSchema, 8192);
    if (!b.ok) return b.res;
    const missionId = b.data.missionId ?? b.data.proposal.mission?.id;
    const r = await service.confirm(b.data.participant, { kind: b.data.proposal.kind, text: b.data.proposal.text, missionId }, [b.data.lng, b.data.lat]);
    return r.ok ? c.json(r) : error(c, r.status, r.code, r.message);
  });

  return { router, service };
}

/**
 * Shapes of the AthensGov Sandbox responses the server depends on. Only the
 * fields we use are declared; unknown fields are dropped. Enumerations the
 * sandbox may extend (status, category) stay plain strings.
 */
import { z } from "zod";

export const REPORT_CATEGORIES = [
  "pothole", "streetlight", "garbage", "bulky_waste", "graffiti", "tree", "sidewalk",
  "abandoned_vehicle", "noise", "stray_animals", "water_leak", "other",
] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

export const reportSchema = z.object({
  id: z.string(),
  category: z.string(),
  category_name: z.string().nullish(),
  title: z.string(),
  description: z.string().nullish(),
  address: z.string().nullish(),
  lat: z.number().nullish(),
  lng: z.number().nullish(),
  /** submitted, received, in_progress, resolved, rejected */
  status: z.string(),
  created_at: z.string(),
  updated_at: z.string().nullish(),
  upvotes: z.number().default(0),
  created_by_you: z.boolean().nullish(),
  distance_km: z.number().nullish(),
});
export type SandboxReport = z.infer<typeof reportSchema>;

const page = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ total: z.number(), page: z.number(), size: z.number(), items: z.array(item) });

export const reportPageSchema = page(reportSchema);

const position = z.tuple([z.number(), z.number()]).rest(z.number());
export const geometrySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("Point"), coordinates: position }),
  z.object({ type: z.literal("MultiPoint"), coordinates: z.array(position) }),
  z.object({ type: z.literal("LineString"), coordinates: z.array(position) }),
  z.object({ type: z.literal("MultiLineString"), coordinates: z.array(z.array(position)) }),
  z.object({ type: z.literal("Polygon"), coordinates: z.array(z.array(position)) }),
  z.object({ type: z.literal("MultiPolygon"), coordinates: z.array(z.array(z.array(position))) }),
]);
export type SandboxGeometry = z.infer<typeof geometrySchema>;

export const projectFeatureSchema = z.object({
  type: z.literal("Feature"),
  id: z.union([z.string(), z.number()]).nullish(),
  geometry: geometrySchema,
  properties: z.object({
    id: z.string(),
    title: z.string(),
    description: z.string().nullish(),
    category: z.string(),
    /** planned, in_progress, completed, paused */
    status: z.string(),
    start_date: z.string().nullish(),
    end_date_planned: z.string().nullish(),
    address: z.string().nullish(),
  }),
});
export type SandboxProject = z.infer<typeof projectFeatureSchema>;

export const projectCollectionSchema = z.object({
  type: z.literal("FeatureCollection"),
  features: z.array(projectFeatureSchema),
});

export const poiSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string(),
  category_name: z.string().nullish(),
  address: z.string().nullish(),
  lat: z.number(),
  lng: z.number(),
  open_now: z.boolean().nullish(),
  wheelchair_accessible: z.boolean().nullish(),
  distance_km: z.number().nullish(),
});
export type SandboxPoi = z.infer<typeof poiSchema>;
export const poiPageSchema = page(poiSchema);

export const conversationSchema = z.object({ id: z.string() });

const cardSchema = z.object({
  type: z.string(),
  id: z.union([z.string(), z.number()]).nullish().transform((v) => (v == null ? null : String(v))),
  title: z.string().nullish(),
  subtitle: z.string().nullish(),
  data: z.record(z.unknown()).nullish(),
});
export type AssistantCard = z.infer<typeof cardSchema>;

export const assistantReplySchema = z.object({
  text: z.string().nullish(),
  speech: z.string().nullish(),
  intent: z.object({ name: z.string(), confidence: z.number().nullish() }).nullish(),
  entities: z.record(z.unknown()).nullish(),
  cards: z.array(cardSchema).default([]),
  engine: z
    .object({
      used: z.string().nullish(),
      fallback_reason: z.string().nullish(),
      llm_remaining_today: z.number().nullish(),
    })
    .nullish(),
  state: z.object({ flow: z.string().nullish(), awaiting: z.string().nullish() }).nullish(),
});
export type AssistantReply = z.infer<typeof assistantReplySchema>;

export const nluParseSchema = z.object({
  intent: z.string(),
  confidence: z.number().nullish(),
  entities: z.record(z.unknown()).default({}),
});
export type NluParse = z.infer<typeof nluParseSchema>;

export const sandboxInfoSchema = z.object({
  rate_limit_per_minute: z.number().nullish(),
  llm: z
    .object({
      enabled: z.boolean().nullish(),
      calls_left_today: z.number().nullish(),
      per_day: z.number().nullish(),
      per_minute: z.number().nullish(),
    })
    .nullish(),
  counts: z.record(z.number()).nullish(),
});
export type SandboxInfo = z.infer<typeof sandboxInfoSchema>;

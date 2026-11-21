/** Step-by-step notes for people with visual impairment, from files extracted into data-local/. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { SourceError } from "./http.ts";
import type { SourceAdapter, SourceMeta } from "./types.ts";

export const ROUTES_META: SourceMeta = {
  id: "accessible-routes",
  name: "Προσβάσιμες Διαδρομές Δήμου Αθηναίων / This is Athens",
  owner: "Δήμος Αθηναίων και This is Athens (accessibleroutes.thisisathens.org)",
  gives: "Notes written by people who walked the routes, for people with visual impairment, with the coordinates of the step's point of interest",
  kind: "static",
  data: "real",
  terms: "Η αναδημοσίευση απαιτεί γραπτή συναίνεση των δικαιούχων.",
  termsUrl: "https://accessibleroutes.thisisathens.org/",
  termsQuoted: false,
  permission: "pending",
  request: "Reads data-local/accessible-routes/*.json (extracted from the public pages once; no request is made while the server runs)",
};

export interface RouteNote {
  routeId: string;
  routeTitle: string;
  order: number;
  title: string;
  /** The Greek text of the step, for the voice to offer. */
  text: string;
  lng: number;
  lat: number;
  /** The coordinates belong to the point of interest named in the step, not to the step itself. */
  coordinatesOf: "point_of_interest";
  poi: { title: string; url: string | null } | null;
  sourceUrl: string | null;
  pageModified: string | null;
}

const fileSchema = z.object({
  route: z.string(),
  route_title: z.string(),
  source_url: z.string().nullish(),
  page_modified: z.string().nullish(),
  steps: z.array(
    z.object({
      order: z.number(),
      title: z.string().nullish(),
      text: z.string(),
      lng: z.number().nullish(),
      lat: z.number().nullish(),
      pois: z.array(z.object({ title: z.string(), url: z.string().nullish() })).nullish(),
    }),
  ),
});

export const FILES = ["visual-impairment-historic-centre.json", "visual-impairment-acropolis.json"];

/** `dir` null means the source is switched off. A missing file is skipped; no file at all is a problem. */
export function routesAdapter(dir: string | null, read: (path: string) => Promise<string> = (p) => readFile(p, "utf8")): SourceAdapter<RouteNote> {
  return {
    meta: ROUTES_META,
    ttlMs: 6 * 3600_000,
    timeoutMs: 2000,
    async fetch() {
      const endpoint = "read data-local/accessible-routes";
      if (!dir) throw new SourceError("not_present", endpoint, "no folder configured");
      const notes: RouteNote[] = [];
      let found = 0;
      for (const name of FILES) {
        let raw: string;
        try {
          raw = await read(join(dir, name));
        } catch {
          continue;
        }
        found++;
        let parsed: z.SafeParseReturnType<unknown, z.infer<typeof fileSchema>>;
        try {
          parsed = fileSchema.safeParse(JSON.parse(raw));
        } catch {
          throw new SourceError("bad_response", endpoint, `${name} is not JSON`);
        }
        if (!parsed.success) throw new SourceError("bad_response", endpoint, `${name} does not have the expected fields`);
        const f = parsed.data;
        for (const step of f.steps) {
          if (typeof step.lng !== "number" || typeof step.lat !== "number") continue; // a step without coordinates cannot be placed
          const poi = step.pois?.[0];
          notes.push({
            routeId: f.route,
            routeTitle: f.route_title,
            order: step.order,
            title: step.title ?? `Βήμα ${step.order}`,
            text: step.text,
            lng: step.lng,
            lat: step.lat,
            coordinatesOf: "point_of_interest",
            poi: poi ? { title: poi.title, url: poi.url ?? null } : null,
            sourceUrl: f.source_url ?? null,
            pageModified: f.page_modified ?? null,
          });
        }
      }
      if (found === 0) throw new SourceError("not_present", endpoint, "the extracted files are not present");
      return notes;
    },
  };
}

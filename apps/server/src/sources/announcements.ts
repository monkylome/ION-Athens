/** City announcements about traffic arrangements (free text, no coordinates). */
import { z } from "zod";
import { SourceError, fetchJson } from "./http.ts";
import { fold, htmlText } from "./text.ts";
import type { SourceAdapter, SourceMeta } from "./types.ts";

const API = "https://www.cityofathens.gr/wp-json/wp/v2/posts";
const QUERY = "κυκλοφοριακές ρυθμίσεις";

export const ANNOUNCEMENTS_META: SourceMeta = {
  id: "athens-announcements",
  name: "Ανακοινώσεις Δήμου Αθηναίων: κυκλοφοριακές ρυθμίσεις",
  owner: "Δήμος Αθηναίων (cityofathens.gr)",
  gives: "Recent announcements about traffic arrangements: title, date, link, and streets named in the text that exist in the walking graph (hints only)",
  kind: "daily",
  data: "real",
  terms: "απαγορεύεται ρητά η αναπαραγωγή, αναδημοσίευση, αντιγραφή … χωρίς τη ρητή προηγούμενη έγγραφη συναίνεση του Δικαιούχου",
  termsUrl: "https://www.cityofathens.gr/oroi-chrisis/",
  termsQuoted: true,
  permission: "pending",
  request: `GET ${API}?search=${QUERY}&per_page=20&orderby=date&_fields=id,date,title,link,content`,
};

export interface Announcement {
  id: number;
  title: string;
  /** ISO date-time as published, Athens local time without offset. */
  date: string;
  link: string;
  /** The text, used only to find street names. It is never sent to the screens. */
  text: string;
}

const postSchema = z.object({
  id: z.number(),
  date: z.string(),
  link: z.string(),
  title: z.object({ rendered: z.string() }),
  content: z.object({ rendered: z.string() }).optional(),
});

export function parseAnnouncements(raw: unknown): Announcement[] {
  const endpoint = "GET www.cityofathens.gr/wp-json/wp/v2/posts";
  if (!Array.isArray(raw)) throw new SourceError("bad_response", endpoint, "the answer is not a list");
  const out: Announcement[] = [];
  for (const row of raw) {
    const p = postSchema.safeParse(row);
    if (!p.success) continue;
    const title = htmlText(p.data.title.rendered);
    // The site search is loose; keep only what is about traffic arrangements.
    if (!fold(title).includes("ΚΥΚΛΟΦΟΡΙΑΚ")) continue;
    out.push({ id: p.data.id, title, date: p.data.date, link: p.data.link, text: htmlText(p.data.content?.rendered ?? "") });
  }
  if (raw.length > 0 && !raw.some((r) => postSchema.safeParse(r).success)) throw new SourceError("bad_response", endpoint, "no row has the documented fields");
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

export const announcementsAdapter: SourceAdapter<Announcement> = {
  meta: ANNOUNCEMENTS_META,
  ttlMs: 30 * 60_000,
  timeoutMs: 10_000,
  async fetch(_q, env) {
    const url = `${API}?search=${encodeURIComponent(QUERY)}&per_page=20&orderby=date&order=desc&_fields=id,date,title,link,content`;
    return parseAnnouncements(await fetchJson(env, url, "GET www.cityofathens.gr/wp-json/wp/v2/posts"));
  },
};

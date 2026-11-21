/**
 * Hospitals on duty in Attica. The Ministry publishes a daily PDF and a .doc;
 * neither is parsed here. A reliable reading of the table needs a PDF reader
 * and a hospital is on duty only for the clinics listed under it, so the adapter
 * finds today's document and gives its link. `onDuty` stays unknown.
 */
import { fetchText } from "./http.ts";
import { fold } from "./text.ts";
import type { SourceAdapter, SourceMeta } from "./types.ts";

export const MOH_PAGE = "https://www.moh.gov.gr/articles/citizen/efhmeries-nosokomeiwn/68-efhmeries-nosokomeiwn-attikhs";

export const MOH_META: SourceMeta = {
  id: "moh-duty-hospitals",
  name: "Εφημερίες νοσοκομείων Αττικής",
  owner: "Υπουργείο Υγείας (moh.gov.gr)",
  gives: "The link to today's duty list (PDF and .doc); which hospitals are on duty is not read from it",
  kind: "daily",
  data: "real",
  terms: "Δεν βρέθηκαν όροι επαναχρησιμοποίησης στη σελίδα.",
  termsUrl: MOH_PAGE,
  termsQuoted: false,
  permission: "pending",
  request: `GET ${MOH_PAGE} (HTML, the list of daily files)`,
};

export interface DutyDocument {
  /** YYYY-MM-DD */
  date: string;
  title: string;
  pdfUrl: string | null;
  docUrl: string | null;
}

const MONTHS = ["ΙΑΝΟΥΑΡΙΟΥ", "ΦΕΒΡΟΥΑΡΙΟΥ", "ΜΑΡΤΙΟΥ", "ΑΠΡΙΛΙΟΥ", "ΜΑΙΟΥ", "ΙΟΥΝΙΟΥ", "ΙΟΥΛΙΟΥ", "ΑΥΓΟΥΣΤΟΥ", "ΣΕΠΤΕΜΒΡΙΟΥ", "ΟΚΤΩΒΡΙΟΥ", "ΝΟΕΜΒΡΙΟΥ", "ΔΕΚΕΜΒΡΙΟΥ"];

function dateOfName(name: string): string | null {
  const file = /efimeria_(\d{4})(\d{2})(\d{2})/i.exec(name);
  if (file) return `${file[1]}-${file[2]}-${file[3]}`;
  const greek = /(\d{1,2})\s+(\S+)\s+(\d{4})/.exec(fold(name));
  const month = greek ? MONTHS.indexOf(greek[2]!) : -1;
  if (!greek || month < 0) return null;
  return `${greek[3]}-${String(month + 1).padStart(2, "0")}-${greek[1]!.padStart(2, "0")}`;
}

export function parseDutyPage(html: string): DutyDocument[] {
  const byDate = new Map<string, DutyDocument>();
  for (const m of html.matchAll(/href="\?fdl=(\d+)"[^>]*?title="Download:\s*([^"]+?)\s*\(/g)) {
    const name = m[2]!;
    const date = dateOfName(name);
    if (!date) continue;
    const url = `${MOH_PAGE}?fdl=${m[1]}`;
    const doc = byDate.get(date) ?? { date, title: "", pdfUrl: null, docUrl: null };
    if (/\.pdf$/i.test(name)) {
      doc.pdfUrl = url;
      doc.title = name.replace(/\.pdf$/i, "");
    } else if (/\.docx?$/i.test(name)) doc.docUrl = url;
    byDate.set(date, doc);
  }
  return [...byDate.values()].map((d) => ({ ...d, title: d.title || `Εφημερίες ${d.date}` })).sort((a, b) => b.date.localeCompare(a.date));
}

/** Today's date in Athens as YYYY-MM-DD. */
export function athensDate(now: Date): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Athens", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export const hospitalsAdapter: SourceAdapter<DutyDocument> = {
  meta: MOH_META,
  ttlMs: 30 * 60_000,
  timeoutMs: 10_000,
  async fetch(_q, env) {
    return parseDutyPage(await fetchText(env, MOH_PAGE, "GET www.moh.gov.gr/articles/citizen/efhmeries-nosokomeiwn/68-efhmeries-nosokomeiwn-attikhs", "text/html"));
  },
};

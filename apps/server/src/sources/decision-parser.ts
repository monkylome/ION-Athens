export function normal(text: string) {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/ς/g, "σ").replace(/\s+/g, " ").trim();
}

export function streetKey(text: string) {
  return normal(text).replace(/^(?:(?:τησ|την|τη|του)\s+)?(?:οδ(?:οσ|ου|ο)|λεωφ(?:οροσ|ορου|ορο)?\.?)\s+/u, "").replace(/[.΄’']/g, "").trim();
}
const days = ["κυριακ", "δευτερ", "τριτη", "τεταρτ", "πεμπτ", "παρασκευ", "σαββατ"];
const clock = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Athens", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
export const localDay = (now: Date) => clock.format(now).slice(0, 10);
const addDay = (day: string, n: number) => new Date(Date.parse(day + "T12:00Z") + n * 86400000).toISOString().slice(0, 10);
function iso(d: string, m: string, y: string) {
  const date = [y,m.padStart(2,"0"),d.padStart(2,"0")].join("-");
  const t = Date.parse(date + "T12:00Z");
  return Number.isFinite(t) && new Date(t).toISOString().startsWith(date) ? date : "";
}

export function parseDecision(subject: string) {
  const text = normal(subject);
  const stop = /[,;·»]|\s+(?:στο|στη|μεταξυ|απο|εωσ|μεχρι|για|περιοχησ|κατα|λογω|στισ|την|τισ|και στην|του δημου)\s/u;
  const clean = (s: string) => s.split(stop)[0]!.trim().replace(/[.\s]+$/, "");
  const refs = [...text.matchAll(/(?<!\p{L})(?:οδου|οδο|λεωφ\.|λεωφορου|λεωφορο|λ\.)\s+/gu)].map(m => clean(text.slice(m.index + m[0].length)));
  const between = text.match(/μεταξυ (?:των )?οδων (.+?) και (.+)/u);
  const stretch = text.match(/απο (?:το υψοσ |την? )?(?:τησ )?(?:συμβολησ? τησ με )?(?:την? )?οδο (.+?) (?:εωσ|μεχρι) (?:το υψοσ |την? )?(?:τησ )?(?:συμβολησ? τησ με )?(?:την? )?οδο (.+)/u);
  const ends = between ?? stretch;
  const cross = ends ? [clean(ends[1]!), clean(ends[2]!)] : [];
  const address = text.match(/(?:ο\s*\.\s*α\s*\.?|αριθμου)\s*(\d+[α-ω]?)/u)?.[1];
  const datePart = text.split(/(?:περιοχησ δημου αθηναιων|χρονικο διαστημα)/u).at(-1)!;
  const dates = [...datePart.matchAll(/(?<!\d)(\d{1,2})[-/.](\d{1,2})[-/.](20\d{2})(?!\d)/g)];
  const calendar = dates.map(m => iso(m[1]!,m[2]!,m[3]!));
  const shared = datePart.match(/(\d{1,2}) και (\d{1,2})[-/.](\d{1,2})[-/.](20\d{2})/);
  if (shared) calendar.unshift(iso(shared[1]!,shared[3]!,shared[4]!));
  const range = dates.length === 2 && /(?:εωσ|μεχρι)/.test(datePart.slice(dates[0]!.index! + dates[0]![0].length,dates[1]!.index));
  const endOnly = dates.length === 1 && /(?:εωσ|μεχρι)(?: και)? (?:τισ? |την )?$/.test(datePart.slice(0, dates[0]!.index));
  const times = [...datePart.matchAll(/(?<![\d.])(\d{1,2})[:.](\d{2})(?![\d.])/g)];
  const hours = times.map(m => Number(m[1])*60 + Number(m[2]));
  const weekdays = days.flatMap((day,i) => datePart.includes(day) ? [i] : []);
  const kind = /λωριδ/.test(text) ? "lane" : /γεραν|οψεων|προσοψ|εκτελεσησ εργασιων|ανυψωσησ/.test(text) ? "works" : /πορειασ|εκδηλωσ/.test(text) ? "event" : /πεζοδρομησ/.test(text) ? "pedestrian_zone" : /διακοπη|αποκλεισμ/.test(text) ? "closure" : "unknown";
  const fullPedestrian = /(?:πληρησ? διακοπη|απαγορευση) (?:τησ )?(?:κυκλοφοριασ|διελευσησ) (?:των )?πεζων/.test(text);
  const multi = /και (?:στην?|τησ) οδο|κατωθι οδικων τμηματων|οδικο αξονα .+,/.test(text);
  const unresolved = /παραταση|αρση |τροποποιηση|εξαιρ|αργι|εναλλαξ|μεγιστου μηκουσ|αποφασεισ που|δεν (?:απαγορευεται|διακοπτεται)/.test(text);
  const validSchedule = calendar.length > 0 && calendar.every(Boolean) && (calendar.length === 1 || (shared && dates.length === 1) || (range && calendar.length === 2) || (calendar.length === 2 && datePart.slice(dates[0]!.index!+dates[0]![0].length, dates[1]!.index).trim()==="και")) &&
    (hours.length === 0 || hours.length === 2) && times.every(m => Number(m[1]) < 24 && Number(m[2]) < 60) && (!/ωρ(?:εσ|ων|α)\s/.test(datePart) || hours.length === 2) && !unresolved &&
    !(weekdays.length>1 && /(?:δευτερα|τριτη|τεταρτη|πεμπτη|παρασκευη|σαββατο|κυριακη) (?:εωσ|μεχρι)/.test(datePart));
  return { subject, street: refs[0] ?? "", streets: [...new Set([...refs, ...cross])], cross, address, dates: calendar, range, endOnly, hours, weekdays, kind, fullPedestrian, multi, validSchedule: Boolean(validSchedule), confidence: refs.length && ends && !multi && validSchedule ? 0.8 : 0.3 };
}
export type Parsed = ReturnType<typeof parseDecision>;
export function activeUntil(p: Parsed, issued: Date, now: Date): string | null {
  if (!p.validSchedule || now < issued) return null;
  const stamp = clock.format(now);
  const today = stamp.slice(0,10);
  const minutes = Number(stamp.slice(11,13))*60 + Number(stamp.slice(14,16));
  const [start=0,end=1440] = p.hours;
  const overnight = end < start;
  const previous = overnight && minutes < end;
  if (overnight ? minutes >= end && minutes < start : minutes < start || minutes >= end) return null;
  const day = previous ? addDay(today,-1) : today;
  const last = p.dates.at(-1)!;
  if (p.range || p.endOnly ? day < (p.endOnly ? localDay(issued) : p.dates[0]!) || day > last : !p.dates.includes(day)) return null;
  if (p.weekdays.length && !p.weekdays.includes(new Date(day+"T12:00Z").getUTCDay())) return null;
  const endDay = addDay(day, overnight || end === 1440 ? 1 : 0);
  const target = Date.parse(endDay+"T00:00Z") + (end % 1440)*60000;
  // Athens alternates between UTC+2 and UTC+3. Verify the actual local instant.
  for (const offset of [3,2]) {
    const candidate = new Date(target-offset*3600000);
    if (clock.format(candidate).replace(" ","T") === new Date(target).toISOString().slice(0,16) && candidate > now) return candidate.toISOString();
  }
  return null;
}

/** Exact starts within seven days, evaluated against the same Athens schedule as routing. */
export function upcomingStart(parse: Parsed, issued: Date, now: Date) {
  if (!parse.validSchedule || activeUntil(parse, issued, now)) return null;
  const localMidnight = Date.parse(localDay(now) + "T00:00Z");
  const horizon = +now + 7 * 86400000;
  for (let day = 0; day <= 7; day++) {
    const wall = localMidnight + day * 86400000 + (parse.hours[0] ?? 0) * 60000;
    for (const offset of [3, 2]) {
      const start = new Date(wall - offset * 3600000);
      if (+start > +now && +start <= horizon && activeUntil(parse, issued, start) &&
          !activeUntil(parse, issued, new Date(+start - 1))) return start.toISOString();
    }
  }
  return null;
}

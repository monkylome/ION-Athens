/**
 * /play: the game. The map is the screen. You stand on it; missions stand in
 * the city around you as objects; you walk to one, answer one question on the
 * spot, a stamp lands and the object goes into your album. Two matching
 * answers from two people change the map for everyone.
 *
 * The server holds the rules (`apps/server`, "Citizen missions"). This screen
 * is the board, the encounter (camera or card), the album, the ticket, and
 * the same game as a tray of real buttons for people who do not see the map.
 *
 * No points for time or for sharing a position, no streaks, no ranking of
 * people (`data-local/catalogue/GAME-TOOLING.md`, section 4).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { motion, useReducedMotion } from "motion/react";
import { ArrowLeft, ArrowsIn, ArrowsOut, ArrowUp, BookOpen, Camera as CameraIcon, Eye, HandHeart, Info, Lifebuoy, ListBullets, MapPin, Microphone, Path, Scan, SpeakerHigh, SpeakerSlash, Ticket as TicketIcon, X } from "@phosphor-icons/react";
import type { LngLat } from "@ion/core";
import { cancelSpeech, speak } from "../voice/speech";
import { ApiError, participantId, playApi } from "./api";
import { Board, type Flash } from "./Board";
import { Camera, cameraObstacle } from "./Camera";
import { feel, unlock } from "./feel";
import {
  MERGE_M, addStamp, albumTiles, changeSentence, crossed, describeNearby, nearby, outcome, outsideLine, parseSpokenAnswer, places, pointsWords,
  discoveryEvent, mergeDiscoveries, readDiscovery, readNeighbourhood, refusal, visionReady, type Answer, type Board as BoardData, type Discovery, type Mission, type Nearby, type Neighbourhood, type Observation, type Outcome,
  type Place, type Profile, type Reward, type Rewards, type StampRecord, type Venue,
} from "./game";
import { bearingDeg, CAMERA_FOV_DEG, distanceM, distanceWords, directionWords, moveBy, reachM, REACH_M, shortDistance } from "./geo";
import { Album, Answers, FakePad, FICTIONAL_NOTE, Glyph, Hud, LevelUp, NearTiles, RewardsView, Stamp, Standing, Ticket, VenueCard } from "./parts";
import { parseFake, POSITION_WORDS, requestCompass, useFakeWalk, useHeading, usePosition, type Position } from "./sensors";
import "./play.css";

const CENTRE: LngLat = [23.7275, 37.9775]; // where the board looks before it knows where the player is
const RADIUS_M = 400;
const LIMIT = 40;
const FAR_RADIUS_M = 5000; // the widest the server searches

interface Moment { outcome: Outcome; earned: number; before: number; after: number; mission: Mission }
interface Sheet { id: string; camera: boolean }
type Takeover = { kind: "level"; name: string; next: Profile["nextLevel"] } | { kind: "ticket"; rewards: Reward[] };
type Panel = "menu" | "near" | "album" | "rewards" | null;

function stored(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function store(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
}
function readAlbum(participant: string): StampRecord[] {
  try { const list = JSON.parse(stored(`ion-play-album:${participant}`) ?? "[]") as unknown; return Array.isArray(list) ? list as StampRecord[] : []; } catch { return []; }
}

function enterFullscreen(): void {
  try {
    const root = document.documentElement;
    if (!document.fullscreenElement && root.requestFullscreen) void root.requestFullscreen({ navigationUI: "hide" }).catch(() => undefined);
  } catch { /* not allowed here: the game works in the page */ }
}

type Recognition = { lang: string; maxAlternatives: number; onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null; onerror: (() => void) | null; onend: (() => void) | null; start(): void; abort(): void };
function recognitionCtor(): (new () => Recognition) | null {
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function Play() {
  const receipt = useLocation().state?.scanReceipt;
  const [params] = useSearchParams();
  const fakeParam = useMemo(() => parseFake(params.get("fake")), [params]);
  const preset = params.get("loop") ?? "acropolis";
  const demo = params.get("demo") === "1";
  const fov = Number(params.get("fov")) > 10 ? Math.min(120, Number(params.get("fov"))) : CAMERA_FOV_DEG;
  const participant = useMemo(participantId, []);
  const reduced = useReducedMotion();

  // Stage position: `?fake=lng,lat`, or with `?demo=1` alone the rehearsed start the server gives.
  const [stage, setStage] = useState<{ at: LngLat; heading: number } | null>(fakeParam ? { at: fakeParam, heading: 0 } : null);
  const [stageFailed, setStageFailed] = useState(false);
  useEffect(() => {
    if (!demo || fakeParam) return;
    let current = true;
    playApi.demoLoop(preset).then((loop) => {
      if (!current) return;
      if (!loop.start) { setStageFailed(true); return; }
      const at: LngLat = loop.obstacle?.position ?? [loop.start.lng, loop.start.lat];
      // Face the place the walk ends at, so the landmark is ahead.
      setStage({ at, heading: loop.destination ? bearingDeg(at, [loop.destination.lng, loop.destination.lat]) : 0 });
    }, () => { if (current) setStageFailed(true); });
    return () => { current = false; };
  }, [demo, fakeParam, preset]);
  const staged = !!fakeParam || (demo && !stageFailed);

  const [voice, setVoice] = useState(() => stored("ion-play-voice") !== "off");
  const [cameraFirst, setCameraFirst] = useState(() => stored("ion-play-camera") !== "off");
  const [panel, setPanel] = useState<Panel>(null);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [moment, setMoment] = useState<Moment | null>(null);
  const [busy, setBusy] = useState(false);
  const [cardNote, setCardNote] = useState("");
  const [listening, setListening] = useState(false);
  const [board, setBoard] = useState<BoardData | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [rewards, setRewards] = useState<Rewards | null>(null);
  const [neighbourhood, setNeighbourhood] = useState<Neighbourhood | null>(null);
  const [venues, setVenues] = useState<Record<string, Venue>>({});
  const [album, setAlbum] = useState<StampRecord[]>(() => readAlbum(participant));
  const [takeovers, setTakeovers] = useState<Takeover[]>([]);
  const [toast, setToast] = useState<{ text: string; confirmed: boolean } | null>(null);
  const [flashes, setFlashes] = useState<Flash[]>([]);
  const [aimId, setAimId] = useState<string | null>(null);
  const [callout, setCallout] = useState<string | null>(null);
  const [focus, setFocus] = useState<LngLat | null>(null);
  const [flying, setFlying] = useState<Mission | null>(null);
  const [caption, setCaption] = useState("");
  const [live, setLive] = useState("");
  const [offline, setOffline] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [scan, setScan] = useState(false);
  const [discoveries, setDiscoveries] = useState<Discovery[]>([]);
  const [shownPoints, setShownPoints] = useState<number | null>(receipt?.before ?? null);

  const answered = useMemo(() => new Set(album.map((s) => s.id)), [album]);
  const walk = useFakeWalk(stage?.at ?? null, stage?.heading ?? 0, !moment && !(sheet && !sheet.camera) && takeovers.length === 0 && panel === null);
  const real = usePosition(!staged);
  const position: Position = walk ? { point: walk.point, status: "fake", course: null } : real;
  const heading = useHeading(true, walk ? walk.heading : null, real.course);
  const point = position.point;

  /* ---------- one voice: speech when it is on, the live region when it is off ---------- */
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const say = useCallback((text: string, priority = 1) => {
    setCaption(text);
    if (voiceRef.current && "speechSynthesis" in window) speak(text, { priority, rate: 1.1 });
    // The same sentence twice must still be announced, so the region is emptied first.
    else { setLive(""); window.setTimeout(() => setLive(text), 60); }
  }, []);

  // Sound, speech and (on iOS) the compass wake on the first tap. There is no start page.
  // A tap, not a touch-down: on a touch screen only the end of a touch counts as the person's gesture.
  const woke = useRef(false);
  const fullscreen = useRef<"never" | "entered" | "left">("never");
  const wake = useCallback(() => {
    // The first taps also ask for the whole screen: the browser's bars take a fifth of a phone.
    // Asked until it is granted once; a person who then leaves full screen is not pulled back in.
    if (fullscreen.current === "never" && stored("ion-play-fullscreen") !== "off") enterFullscreen();
    if (woke.current) return;
    woke.current = true;
    void unlock();
    void requestCompass();
  }, []);
  const [full, setFull] = useState(false);
  useEffect(() => {
    const onChange = () => {
      const now = !!document.fullscreenElement;
      if (now) fullscreen.current = "entered"; else if (fullscreen.current === "entered") fullscreen.current = "left";
      setFull(now);
    };
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("click", wake, true);
    document.addEventListener("keydown", wake, true);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("click", wake, true);
      document.removeEventListener("keydown", wake, true);
    };
  }, [wake]);
  function toggleFullscreen() {
    if (document.fullscreenElement) { store("ion-play-fullscreen", "off"); void document.exitFullscreen().catch(() => undefined); }
    else { store("ion-play-fullscreen", "on"); enterFullscreen(); }
  }

  /* ---------- data ---------- */
  const fetchAt = useRef<LngLat | null>(null);
  const [fetchPoint, setFetchPoint] = useState<LngLat | null>(null);
  useEffect(() => {
    if (!point) return;
    // Ask again only after a real move: the objects around a person do not change with every step.
    if (fetchAt.current && distanceM(fetchAt.current, point) < 25) return;
    fetchAt.current = point;
    setFetchPoint(point);
  }, [point]);
  useEffect(() => {
    if (!fetchPoint) return;
    let current = true;
    playApi.missions(fetchPoint, RADIUS_M, LIMIT)
      // Nothing within walking distance: the player is outside the mapped area. Find the nearest missions anyway.
      .then((data) => (data.missions.length > 0 ? data : playApi.missions(fetchPoint, FAR_RADIUS_M, 5)))
      .then(
        (data) => { if (current) { setBoard(data); setOffline(false); } },
        () => { if (current) setOffline(true); },
      );
    return () => { current = false; };
  }, [fetchPoint, refresh]);

  // Points and levels only ever arrive from the server. A new level or a reward's threshold stops the game for a moment.
  const known = useRef<Profile | null>(null);
  const rewardsRef = useRef<Rewards | null>(null);
  rewardsRef.current = rewards;
  const takeProfile = useCallback((next: Profile) => {
    const before = known.current;
    known.current = next;
    setProfile(next);
    if (!before || next.points <= before.points) return;
    const queue: Takeover[] = [];
    if (next.level !== before.level) queue.push({ kind: "level", name: next.level, next: next.nextLevel });
    const won = rewardsRef.current ? crossed(rewardsRef.current.rewards, before.points, next.points) : [];
    if (won.length > 0) queue.push({ kind: "ticket", rewards: won });
    if (queue.length > 0) setTakeovers((list) => [...list, ...queue]);
  }, []);
  useEffect(() => {
    let current = true;
    playApi.rewards(participant, demo).then((data) => { if (current) setRewards(data); }, () => undefined);
    return () => { current = false; };
  }, [participant, demo, profile?.points]);
  useEffect(() => {
    let current = true;
    playApi.profile(participant).then((data) => { if (current) takeProfile(data); }, () => { if (current) setOffline(true); });
    return () => { current = false; };
  }, [participant, refresh, takeProfile]);

  /* ---------- the board in numbers ---------- */
  const accuracy = position.status === "fake" ? undefined : position.accuracyM;
  const all = useMemo(() => (board && point ? nearby(board.missions, point, accuracy) : []), [board, point, accuracy]);
  const open = useMemo(() => all.filter((n) => !answered.has(n.mission.id)), [all, answered]);
  const spots = useMemo(() => places(all, answered), [all, answered]);
  const nearest = open[0] ?? null;
  // The action points at what the player chose, else at something answerable from here, else at the nearest object.
  const aim = (aimId ? open.find((n) => n.mission.id === aimId) : null) ?? open.find((n) => n.reachable) ?? nearest;
  // Outside the mapped area: nothing within walking distance. The arrow still points at the nearest object.
  const outside = !!board && !!point && (!nearest || nearest.distance > RADIUS_M);
  const reach = reachM(accuracy);

  // A confirmed mission leaves the server's list at once. The encounter that is showing it keeps what it had.
  const held = useRef<Nearby | null>(null);
  const liveTarget = sheet ? all.find((n) => n.mission.id === sheet.id) ?? null : null;
  if (liveTarget) held.current = liveTarget;
  const target = sheet ? liveTarget ?? (held.current?.mission.id === sheet.id ? held.current : null) : null;
  const missionsRef = useRef(all);
  missionsRef.current = all;

  // The neighbourhood the player is in is the one the nearest mission names.
  const area = all[0]?.mission.area;
  useEffect(() => {
    let current = true;
    playApi.neighbourhoods().then(
      (data) => { if (current) setNeighbourhood(readNeighbourhood(data, undefined, area)); },
      () => { if (current) setNeighbourhood(null); }, // the endpoint may not exist: then no figure is shown
    );
    return () => { current = false; };
  }, [area, refresh]);

  // Cards of the places on the board (the nearest few), of the one being answered, and of the album's.
  const venueIds = useMemo(() => {
    const ids = new Set<string>();
    for (const spot of spots) { const id = spot.first.mission.venueId; if (id && ids.size < 8) ids.add(id); }
    if (target?.mission.venueId) ids.add(target.mission.venueId);
    if (panel === "album") for (const s of album) if (s.venueId) ids.add(s.venueId);
    return [...ids].sort().join("|");
  }, [spots, target?.mission.venueId, panel, album]);
  useEffect(() => {
    if (!venueIds) return;
    let current = true;
    for (const id of venueIds.split("|")) {
      playApi.venue(id).then((data) => { if (current && Array.isArray(data?.facts)) setVenues((map) => ({ ...map, [id]: data })); }, () => undefined);
    }
    return () => { current = false; };
  }, [venueIds, refresh]);
  const venue = target?.mission.venueId ? venues[target.mission.venueId] ?? null : null;
  const waiting = useMemo(() => new Set(all.filter((n) => n.mission.venueId && n.mission.venueId === target?.mission.venueId && n.mission.key && (answered.has(n.mission.id) || n.mission.answers.yes + n.mission.answers.no > 0)).map((n) => n.mission.key!)), [all, answered, target?.mission.venueId]);

  // A mission comes into reach: one tick, one sentence. Never the same one twice within 30 seconds.
  const called = useRef(new Map<string, number>());
  const quiet = !!sheet || takeovers.length > 0 || panel !== null;
  useEffect(() => {
    if (quiet) return;
    const first = open.find((n) => n.reachable);
    if (!first) return;
    const last = called.current.get(first.mission.id);
    if (last && Date.now() - last < 30_000) return;
    called.current.set(first.mission.id, Date.now());
    feel.tick();
    say(`Αποστολή στην εμβέλειά σας. ${first.mission.question}`, 0);
  }, [open, quiet, say]);
  useEffect(() => {
    if (outside) say(outsideLine(nearest, accuracy), 1);
  }, [outside]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------- other people's answers, live ---------- */
  const mine = useRef(new Set<string>());
  const flash = useCallback((id: string, at: LngLat, confirmed: boolean) => {
    const key = `${id}-${Date.now()}`;
    setFlashes((list) => [...list.filter((f) => !f.id.startsWith(id + "-")), { id: key, at, confirmed }]);
    window.setTimeout(() => setFlashes((list) => list.filter((f) => f.id !== key)), 6000);
  }, []);
  const sayRef = useRef(say);
  sayRef.current = say;
  useEffect(() => {
    const stream = new EventSource("/api/events");
    const again = () => setRefresh((n) => n + 1);
    const onAnswered = (event: MessageEvent<string>) => {
      again();
      let data: { missionId?: string; position?: LngLat };
      try { data = JSON.parse(event.data); } catch { return; }
      if (!data.missionId || mine.current.has(data.missionId)) return;
      const seen = missionsRef.current.find((n) => n.mission.id === data.missionId);
      if (data.position) flash(data.missionId, data.position, false);
      const text = `Ένας άλλος δημότης απάντησε${seen?.mission.where ? `: ${seen.mission.where}` : ""}.`;
      setToast({ text, confirmed: false });
      feel.elsewhere();
      sayRef.current(text, 0);
    };
    const onUpdated = (event: MessageEvent<string>) => {
      again();
      let data: { observation?: Observation };
      try { data = JSON.parse(event.data); } catch { return; }
      const o = data.observation;
      if (!o || o.type === "camera_discovery") return;
      setMoment(previous => previous?.mission.id === o.missionId
        ? {...previous, outcome:outcome({mission:previous.mission, confirmed:o}, o.value === "no" ? "no" : "yes")} : previous);
      const seen = missionsRef.current.find((n) => n.mission.id === o.missionId);
      if (seen) flash(o.missionId, seen.mission.position, true);
      const text = `Ο χάρτης άλλαξε. ${changeSentence(o, seen?.mission.question)}`;
      setToast({ text, confirmed: true });
      sayRef.current(text, 1);
    };
    // One camera observation and its independent confirmation share a server id.
    const onDiscovery = (event: MessageEvent<string>) => {
      let d: Discovery | null = null;
      try { d = discoveryEvent(JSON.parse(event.data)); } catch { return; }
      if (!d) return;
      const found = d;
      setDiscoveries((list) => mergeDiscoveries(list, [found]));
      flash(`discovery:${found.id}`, found.at, found.confirmed);
      const text = found.confirmed ? `${found.label} · Επιβεβαίωσαν ${found.seenBy} δημότες.` : `${found.label} · Χρειάζεται δεύτερη μαρτυρία.`;
      setToast({ text, confirmed: found.confirmed });
      if (found.confirmed) feel.confirm();
      sayRef.current(text, 1);
    };
    for (const name of ["discovery_added", "discovery_confirmed"]) stream.addEventListener(name, onDiscovery as EventListener);
    stream.addEventListener("mission_answered", onAnswered as EventListener);
    stream.addEventListener("map_updated", onUpdated as EventListener);
    stream.addEventListener("venue_requested", again);
    let subscribed = true;
    const restore = () => {
      again();
      void playApi.discoveries().then(({ discoveries }) => {
        if (!subscribed) return;
        const incoming = discoveries.flatMap(raw => {
          const found = readDiscovery(raw);
          return found ? [found] : [];
        });
        setDiscoveries(previous => mergeDiscoveries(previous, incoming));
      }, () => undefined);
    };
    stream.addEventListener("open", restore);
    return () => { subscribed = false; stream.close(); };
  }, [flash]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 9000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // The scan mode is another screen with a vision model behind it. Its button exists only when the server says a model is there.
  useEffect(() => {
    let current = true;
    playApi.visionStatus().then((body) => { if (current) setScan(visionReady(body)); }, () => { if (current) setScan(false); });
    return () => { current = false; };
  }, []);

  useEffect(() => {
    if (!receipt) return;
    flash("scan", receipt.at, receipt.confirmed);
    setToast({text: receipt.text, confirmed: receipt.confirmed});
  }, [receipt, flash]);

  // The counter at the top left changes only when the map is in view, so the roll-up is seen.
  const hidden = !!sheet || takeovers.length > 0;
  useEffect(() => {
    if (!profile) return;
    if (shownPoints === null) { setShownPoints(profile.points); return; }
    if (hidden || profile.points === shownPoints) return;
    const timer = window.setTimeout(() => setShownPoints(profile.points), reduced ? 0 : 520); // after the object has flown in
    return () => window.clearTimeout(timer);
  }, [profile, hidden, shownPoints, reduced]);

  /* ---------- actions ---------- */
  function toggleVoice() {
    const next = !voice;
    setVoice(next);
    voiceRef.current = next;
    store("ion-play-voice", next ? "on" : "off");
    if (!next) cancelSpeech();
    say(next ? "Η φωνή είναι ανοιχτή." : "Η φωνή έκλεισε. Οι αλλαγές ανακοινώνονται στον αναγνώστη οθόνης.");
  }
  function tellNearby() {
    wake();
    if (!point) { say(POSITION_WORDS[position.status] || "Αναζήτηση της θέσης σας.", 2); return; }
    say(outside ? outsideLine(nearest, accuracy) : describeNearby(open, heading.value, accuracy), 2);
  }
  /** Tapping an object, a tile or the big action. In reach it is an encounter; from afar it is a direction, never a dead end. */
  function approach(n: Nearby, viaCamera: boolean) {
    wake();
    setPanel(null);
    setAimId(n.mission.id);
    if (!n.reachable || answered.has(n.mission.id)) {
      setCallout(n.mission.id);
      feel.tick();
      say(answered.has(n.mission.id)
        ? "Έχετε ήδη απαντήσει εδώ. Χρειάζεται ένας ακόμα δημότης."
        : `${n.mission.where ? `${n.mission.where}: ` : ""}${distanceWords(n.distance, accuracy)} ${directionWords(n.bearing, heading.value)}. Πλησιάστε για να απαντήσετε.`, 1);
      return;
    }
    setCallout(null);
    setCardNote("");
    setMoment(null);
    feel.tick();
    const camera = viaCamera && cameraFirst && cameraObstacle(heading) === null;
    // The view pushes in on the object, then the encounter opens.
    setFocus(n.mission.position);
    window.setTimeout(() => {
      setSheet({ id: n.mission.id, camera });
      say(`${n.mission.question} ${camera ? "Η κάμερα άνοιξε. Οι τρεις απαντήσεις είναι στο κάτω μέρος της οθόνης." : ""}`.trim(), 1);
    }, reduced ? 0 : 440);
  }
  function tapSpot(spot: Place) { approach(spot.first, true); }
  function closeSheet() {
    recognition.current?.abort();
    const caught = moment?.mission ?? null;
    setSheet(null);
    setMoment(null);
    setCardNote("");
    setFocus(null);
    // The capture: the object flies into the album.
    if (caught && !reduced) { setFlying(caught); window.setTimeout(() => setFlying(null), 620); }
  }
  function openCamera() {
    const obstacle = cameraObstacle(heading);
    if (obstacle) { setCardNote(obstacle); say(obstacle, 2); return; }
    setCardNote("");
    setCameraFirst(true);
    store("ion-play-camera", "on");
    setSheet((s) => s && { ...s, camera: true });
    say("Η κάμερα άνοιξε. Στρέψτε το τηλέφωνο προς το σημείο. Οι απαντήσεις είναι στο κάτω μέρος της οθόνης.", 1);
  }
  /** «Χωρίς κάμερα»: this question on the card. A camera that failed or was refused is not tried again by itself. */
  function toCard(message?: string) {
    setSheet((s) => s && { ...s, camera: false });
    if (message) { setCameraFirst(false); store("ion-play-camera", "off"); setCardNote(message); say(message, 2); }
  }
  function calibrate() {
    if (!target) return;
    if (heading.source !== "compass") {
      say(heading.source === "fake" ? "Σε θέση επίδειξης η πυξίδα είναι προσομοίωση: δεν χρειάζεται ρύθμιση." : "Η πυξίδα δεν είναι διαθέσιμη, άρα δεν υπάρχει κάτι να ρυθμιστεί.", 1);
      return;
    }
    heading.calibrate(target.bearing);
    feel.tick();
    say("Η πυξίδα ρυθμίστηκε προς το σημείο.", 1);
  }
  /** Stage only: put the presenter next to the object, facing it. The position label stays on screen. */
  function teleport(n: Nearby) {
    if (!walk) return;
    walk.jump(moveBy(n.mission.position, 180, 12), 0);
    setCallout(null);
    feel.tick();
    say("Μεταφορά στο σημείο. Θέση επίδειξης.", 1);
  }
  function stamp(record: StampRecord) {
    setAlbum((list) => {
      const next = addStamp(list, record);
      store(`ion-play-album:${participant}`, JSON.stringify(next));
      return next;
    });
  }

  async function answer(value: Answer) {
    if (!target || busy) return;
    if (!demo && !point) return;
    const m = target.mission;
    setBusy(true);
    setCardNote("");
    mine.current.add(m.id);
    try {
      const result = demo ? await playApi.demoAnswer(m.id, participant, value) : await playApi.answer(m.id, participant, value, point!);
      const told = outcome(result, value);
      const before = known.current?.points ?? result.profile.points - result.pointsEarned;
      setMoment({ outcome: told, earned: result.pointsEarned, before, after: result.profile.points, mission: m });
      // Caught through the camera: the stamp lands over the picture. Otherwise on the card.
      takeProfile(result.profile);
      stamp({ id: m.id, type: m.type, question: m.question, where: m.where, venueId: m.venueId, confirmed: told.confirmed });
      flash(m.id, m.position, told.confirmed);
      if (told.confirmed) feel.confirm(); else feel.stamp();
      say(`${told.line} ${told.change ?? ""} ${pointsWords(result.pointsEarned)}.`.replace(/\s+/g, " "), 2);
      setRefresh((n) => n + 1);
    } catch (error) {
      const failure = error instanceof ApiError ? error : new ApiError("", 0);
      const text = failure.code === "network" ? "Δεν υπάρχει σύνδεση με τον διακομιστή. Η απάντηση δεν καταχωρίστηκε. Δοκιμάστε ξανά." : refusal(failure.code, failure.message, failure.distanceM);
      // Already answered, or closed by others: it is done for this player, and the object shows it.
      if (failure.code === "already_answered" || failure.code === "closed") stamp({ id: m.id, type: m.type, question: m.question, where: m.where, venueId: m.venueId, confirmed: failure.code === "closed" });
      else mine.current.delete(m.id);
      setSheet({ id: m.id, camera: false });
      setCardNote(text);
      feel.refuse();
      say(text, 2);
    } finally {
      setBusy(false);
    }
  }

  // Answering by voice, where the browser can listen. The words are matched on the phone.
  const recognition = useRef<Recognition | null>(null);
  const canListen = typeof window !== "undefined" && recognitionCtor() !== null;
  function listen() {
    const Ctor = recognitionCtor();
    if (!Ctor) return;
    cancelSpeech();
    const r = new Ctor();
    recognition.current = r;
    r.lang = "el-GR";
    r.maxAlternatives = 3;
    r.onresult = (e) => {
      const heard = Array.from(e.results[0] ?? []).map((a) => a.transcript);
      const value = heard.map(parseSpokenAnswer).find((v) => v !== null) ?? null;
      if (value) void answer(value);
      else { const text = "Δεν κατάλαβα. Πείτε «ναι», «όχι» ή «δεν είμαι σίγουρος»."; setCardNote(text); say(text, 2); }
    };
    r.onerror = () => { setListening(false); setCardNote("Η αναγνώριση φωνής δεν είναι διαθέσιμη τώρα. Πατήστε μία από τις τρεις απαντήσεις."); };
    r.onend = () => setListening(false);
    setListening(true);
    try { r.start(); } catch { setListening(false); }
  }

  useEffect(() => () => cancelSpeech(), []);

  /* ---------- what is on screen ---------- */
  const canAnswer = !!target && target.reachable && !answered.has(target.mission.id);
  const takeover = !sheet && takeovers.length > 0 ? takeovers[0]! : null;
  const takeoverKey = takeover ? (takeover.kind === "level" ? `level:${takeover.name}` : `ticket:${takeover.rewards[0]!.id}`) : "";
  useEffect(() => {
    if (!takeover) return;
    if (takeover.kind === "level") { feel.confirm(); say(`Νέο επίπεδο: ${takeover.name}.`, 2); }
    else say(`Ξεκλειδώσατε ένα προνόμιο: ${takeover.rewards[0]!.title}. ${takeover.rewards[0]!.partner}.`, 2);
  }, [takeoverKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const nextTakeover = () => setTakeovers((list) => list.slice(1));

  // What keeps the demo honest, as one small tag that never leaves the screen.
  const scanParams = new URLSearchParams(params);
  if (walk && point) scanParams.set("fake", point.join(","));
  const scanUrl = "/play/scan?" + scanParams;
  const tag = walk && demo ? "ΘΕΣΗ ΚΑΙ ΑΠΑΝΤΗΣΗ ΕΠΙΔΕΙΞΗΣ" : walk ? "ΘΕΣΗ ΕΠΙΔΕΙΞΗΣ" : demo ? "ΑΠΑΝΤΗΣΗ ΕΠΙΔΕΙΞΗΣ" : "";
  const labels = tag ? <p className="pl-tag">{tag}</p> : null;
  // More questions about the same spot: the encounter offers the next one, unless a level or a ticket is waiting.
  const nextHere = target && moment && takeovers.length === 0
    ? open.find((n) => n.reachable && n.mission.id !== target.mission.id && (n.mission.venueId ? n.mission.venueId === target.mission.venueId : !target.mission.venueId && distanceM(n.mission.position, target.mission.position) <= MERGE_M)) ?? null
    : null;
  const calloutTarget = callout ? all.find((n) => n.mission.id === callout) ?? null : null;
  const inReach = open.filter((n) => n.reachable).length;
  const tiles = albumTiles(album, Object.keys(board?.summary.byType ?? {}));
  const albumVenues = [...new Set(album.flatMap((s) => (s.venueId ? [s.venueId] : [])))].flatMap((id) => (venues[id] ? [venues[id]!] : []));
  const waitingWords = !point ? (POSITION_WORDS[position.status] || "Αναζήτηση θέσης") : !board ? "Φόρτωση" : "Τίποτα κοντά";

  return (
    <div className="play" data-surface="phone">
      <h1 className="visually-hidden">ION Athens: το παιχνίδι στον χάρτη</h1>
      <Board centre={stage?.at ?? CENTRE} player={point} heading={heading.value} reach={reach} spots={spots} venues={venues} discoveries={discoveries} aim={aim} focus={focus} flashes={flashes} onTap={tapSpot} />

      <div className="play__top">
        <Hud points={shownPoints ?? 0} rewards={rewards} onMenu={() => { wake(); setPanel("menu"); }} />
        <div className="play__notes">
          {tag && <p className="pl-tag">{tag}</p>}
          {offline && <p className="pl-plate">Χωρίς σύνδεση</p>}
          {accuracy !== undefined && accuracy > REACH_M && <p className="pl-plate">Ακρίβεια θέσης: {Math.round(accuracy)} μέτρα</p>}
          {outside && <p className="pl-plate">{outsideLine(nearest, accuracy)}</p>}
          {toast && <p className={`pl-plate${toast.confirmed ? " pl-plate--route" : ""}`}>{toast.text}</p>}
        </div>
      </div>

      <div className="play__bottom">
        {calloutTarget && (
          <div className="pl-callout">
            <Glyph mission={calloutTarget.mission} className="pl-callout__glyph" />
            <p className="pl-callout__text">
              <span className="pl-callout__where">{calloutTarget.mission.where?.split(",")[0] || "Σημείο"}</span>
              <span>{answered.has(calloutTarget.mission.id) ? "Απαντήσατε ήδη" : `${distanceWords(calloutTarget.distance, accuracy)} ${directionWords(calloutTarget.bearing, heading.value)}`}</span>
            </p>
            <button type="button" className="pl-callout__close" onClick={() => setCallout(null)} aria-label="Κλείσιμο"><X weight="bold" aria-hidden="true" /></button>
            {walk && !answered.has(calloutTarget.mission.id) && <button type="button" className="btn pl-callout__jump" onClick={() => teleport(calloutTarget)}>Μεταφορά εκεί (επίδειξη)</button>}
          </div>
        )}
        {aim ? (
          aim.reachable ? (
            <button type="button" className="btn btn--primary pl-action" data-on="accent" onClick={() => approach(aim, true)} aria-description={`${aim.mission.question} ${pointsWords(aim.mission.points)}.`}>
              <Glyph mission={aim.mission} className="pl-action__glyph" />
              <span className="pl-action__text"><span className="pl-action__verb">Απαντήστε</span><span className="pl-action__sub">+{aim.mission.points} {aim.mission.where?.split(",")[0] ?? ""}</span></span>
            </button>
          ) : (
            <button type="button" className="btn pl-action" onClick={() => approach(aim, true)} aria-description={`${distanceWords(aim.distance, accuracy)} ${directionWords(aim.bearing, heading.value)}.`}>
              <ArrowUp weight="bold" className="pl-action__glyph" aria-hidden="true" style={{ transform: `rotate(${aim.bearing - (heading.value ?? 0)}deg)` }} />
              <span className="pl-action__text"><span className="pl-action__verb">Πλησιάστε</span><span className="pl-action__sub">{shortDistance(aim.distance)} {directionWords(aim.bearing, heading.value)}</span></span>
            </button>
          )
        ) : <p className="pl-action pl-action--idle">{waitingWords}</p>}
        {scan && <Link className="btn pl-scan" to={scanUrl}><Eye weight="fill" aria-hidden="true" />Σάρωση</Link>}
      </div>

      {flying && (
        <motion.div className="pl-fly" aria-hidden="true" initial={{ left: "50%", top: "45%", scale: 1.6, rotate: -5 }} animate={{ left: "14%", top: "5%", scale: 0.35, rotate: 0 }} transition={{ duration: 0.55, ease: [0.5, 0, 1, 0.7] }}>
          <Glyph mission={flying} />
        </motion.div>
      )}

      {/* Kept readable while a dialog is open: react-aria leaves `data-live-announcer` alone. */}
      <p className="visually-hidden" role="status" aria-live="polite" aria-atomic="true" data-live-announcer="true">{live}</p>

      {/* The menu, and what it opens. «Κοντά σας» is the board as real buttons: the game for a screen reader. */}
      <ModalOverlay isOpen={panel !== null} isDismissable onOpenChange={(isOpen) => { if (!isOpen) setPanel(null); }} className="pl-sheet">
        <Modal className="pl-sheet__modal">
          <Dialog className="pl-sheet__dialog" aria-label={panel === "rewards" ? "Προνόμια" : panel === "album" ? "Το άλμπουμ μου" : panel === "near" ? "Κοντά σας" : "Μενού"}>
            {panel === "menu" && (
              <section className="pl-pane">
                <div className="pl-pane__head">
                  <h2 tabIndex={-1}>Μενού</h2>
                  <button type="button" className="btn btn--quiet pl-pane__close" onClick={() => setPanel(null)}><X weight="bold" className="btn__icon" aria-hidden="true" />Χάρτης</button>
                </div>
                {labels}
                <Standing profile={profile} rewards={rewards} />
                <nav className="pl-menu" aria-label="Μενού">
                  <button type="button" className="btn" onClick={()=>{
                    const next = new URL(window.location.href);
                    next.searchParams.delete("fake");
                    if (demo) next.searchParams.delete("demo"); else next.searchParams.set("demo","1");
                    window.location.assign(next.href);
                  }}>{demo ? "Πίσω στη θέση μου" : "Στη διαδρομή της επίδειξης"}</button>
                  <button type="button" className="btn" onClick={() => setPanel("album")}><BookOpen weight="fill" className="btn__icon" aria-hidden="true" />Το άλμπουμ μου<span className="pl-menu__count">{album.length}</span></button>
                  <button type="button" className="btn" onClick={() => setPanel("rewards")}><TicketIcon weight="fill" className="btn__icon" aria-hidden="true" />Προνόμια</button>
                  <button type="button" className="btn" onClick={() => setPanel("near")}><ListBullets weight="bold" className="btn__icon" aria-hidden="true" />Κοντά σας<span className="pl-menu__count">{inReach}</span></button>
                  <button type="button" className="btn" onClick={tellNearby}><SpeakerHigh weight="fill" className="btn__icon" aria-hidden="true" />Πείτε μου τι υπάρχει κοντά</button>
                  {caption && <p className="pl-pane__caption">{caption}</p>}
                  <button type="button" className="btn" aria-pressed={voice} onClick={toggleVoice}>
                    {voice ? <SpeakerHigh weight="bold" className="btn__icon" aria-hidden="true" /> : <SpeakerSlash weight="bold" className="btn__icon" aria-hidden="true" />}
                    {voice ? "Φωνή: ανοιχτή" : "Φωνή: κλειστή, για αναγνώστη οθόνης"}
                  </button>
                  <Link className="btn" to="/play/trail"><Path weight="bold" className="btn__icon" aria-hidden="true" />Καταγραφή διαδρομής μέσα σε χώρο</Link>
                  {scan && <Link className="btn" to={scanUrl}><Scan weight="bold" className="btn__icon" aria-hidden="true" />Σάρωση με την κάμερα</Link>}
                  <Link className="btn" to="/phone/help"><Lifebuoy weight="bold" className="btn__icon" aria-hidden="true" />Ζητήστε βοήθεια</Link>
                  <Link className="btn" to="/missions/help"><HandHeart weight="bold" className="btn__icon" aria-hidden="true" />Δώστε βοήθεια</Link>
                  <button type="button" className="btn" onClick={toggleFullscreen}>{full ? <ArrowsIn weight="bold" className="btn__icon" aria-hidden="true" /> : <ArrowsOut weight="bold" className="btn__icon" aria-hidden="true" />}{full ? "Έξοδος από πλήρη οθόνη" : "Πλήρης οθόνη"}</button>
                  <Link className="btn" to="/about"><Info weight="bold" className="btn__icon" aria-hidden="true" />Σχετικά</Link>
                  {demo && <button className="btn" type="button" onClick={() => {
                    if (!window.confirm("Να ξεκινήσει νέα επίδειξη σε αυτή τη συσκευή με νέο άλμπουμ και μηδέν πόντους;")) return;
                    try {
                      localStorage.removeItem("ion-play-album:" + participant);
                      localStorage.removeItem("ion-demo-participant");
                      window.location.replace("/play?demo=1&loop="+encodeURIComponent(preset));
                    } catch { say("Ο browser δεν επέτρεψε την αλλαγή αποθηκευμένων στοιχείων."); }
                  }}>Νέα επίδειξη</button>}
                </nav>
                {walk && <>
                  <h2>Επίδειξη</h2>
                  <p className="pl-pane__lead">Μετακίνηση της θέσης επίδειξης. Στο πληκτρολόγιο: τα βέλη.</p>
                  <FakePad walk={walk} />
                </>}
              </section>
            )}
            {panel === "near" && (
              <section className="pl-pane">
                <button type="button" className="btn btn--quiet pl-pane__close" onClick={() => setPanel("menu")}><ArrowLeft weight="bold" className="btn__icon" aria-hidden="true" />Πίσω</button>
                <h1 tabIndex={-1}>Κοντά σας</h1>
                {labels}
                {neighbourhood && !outside && <p className="pl-pane__lead">{neighbourhood.name}: {neighbourhood.done} από {neighbourhood.total} σημεία στον χάρτη</p>}
                {outside && <p className="pl-pane__lead">{outsideLine(nearest, accuracy)}</p>}
                <button type="button" className="btn" onClick={tellNearby}><SpeakerHigh weight="fill" className="btn__icon" aria-hidden="true" />Πείτε μου τι υπάρχει κοντά</button>
                {caption && <p className="pl-pane__caption">{caption}</p>}
                <NearTiles items={all.slice(0, 20)} answered={answered} heading={heading.value} accuracyM={accuracy} onOpen={(n) => approach(n, false)} />
                <p><Link to="/missions">Απλή σελίδα αποστολών, χωρίς χάρτη</Link></p>
              </section>
            )}
            {panel === "rewards" && <RewardsView rewards={rewards} points={profile?.points ?? 0} onClose={() => setPanel("menu")} />}
            {panel === "album" && <Album tiles={tiles} total={album.length} neighbourhood={neighbourhood} venues={albumVenues} discoveries={discoveries} onClose={() => setPanel("menu")} />}
          </Dialog>
        </Modal>
      </ModalOverlay>

      {/* The encounter: the camera when it is there, the card always. */}
      <ModalOverlay isOpen={!!sheet && !!target} onOpenChange={(isOpen) => { if (!isOpen) closeSheet(); }} className="pl-sheet">
        <Modal className="pl-sheet__modal">
          <Dialog className="pl-sheet__dialog" aria-label={target ? `Αποστολή: ${target.mission.question}` : "Αποστολή"}>
            {target && sheet?.camera ? (
              <Camera target={target} heading={heading} fov={fov} tag={labels} caught={moment} onCalibrate={calibrate} onCard={() => toCard()} onFail={toCard} onLeave={closeSheet}
                answers={<>
                  <Answers disabled={busy || !canAnswer} onAnswer={(v) => void answer(v)} />
                  {walk && <FakePad walk={walk} />}
                </>}
                after={nextHere
                  ? <>
                      <button type="button" className="btn btn--primary" data-on="accent" autoFocus onClick={() => { setMoment(null); setCardNote(""); setSheet({ id: nextHere.mission.id, camera: true }); }}>Επόμενη ερώτηση εδώ</button>
                      <button type="button" className="btn btn--quiet" onClick={closeSheet}>Πίσω στον χάρτη</button>
                    </>
                  : <button type="button" className="btn btn--primary" data-on="accent" autoFocus onClick={closeSheet}>Συνέχεια</button>} />
            ) : target && (
              <div className="pl-card">
                <div className="pl-card__top">
                  <button type="button" className="btn btn--quiet pl-card__back" onClick={closeSheet}><ArrowLeft weight="bold" className="btn__icon" aria-hidden="true" />Χάρτης</button>
                  {labels}
                </div>
                {venue && <VenueCard venue={venue} currentKey={moment ? undefined : target.mission.key} waiting={waiting} />}
                {moment ? (
                  <>
                    <Stamp {...moment} />
                    {nextHere
                      ? <>
                          <button type="button" className="btn btn--primary btn--tall" data-on="accent" autoFocus onClick={() => { setMoment(null); setCardNote(""); setSheet({ id: nextHere.mission.id, camera: false }); }}>Επόμενη ερώτηση εδώ</button>
                          <button type="button" className="btn" onClick={closeSheet}>Πίσω στον χάρτη</button>
                        </>
                      : <button type="button" className="btn btn--primary btn--tall" data-on="accent" autoFocus onClick={closeSheet}>Συνέχεια</button>}
                  </>
                ) : (
                  <>
                    {demo && target.mission.type === "obstacle_check" && <p>Υπάρχει ήδη αναφορά επίδειξης. Βλέπετε κι εσείς το εμπόδιο;</p>}
                    {!venue && <p className="pl-card__where"><MapPin weight="fill" className="btn__icon" aria-hidden="true" />{target.mission.where || "Σημείο στον χάρτη"}</p>}
                    <h2 className="pl-card__question">{target.mission.question}</h2>
                    <p className="pl-card__meta">
                      <span className="pl-card__points"><Glyph mission={target.mission} className="btn__icon" />+{target.mission.points} πόντοι</span>
                      {target.mission.answers.yes + target.mission.answers.no > 0 && <span>Ένας δημότης απάντησε ήδη. Η δική σας απάντηση μπορεί να αλλάξει τον χάρτη.</span>}
                    </p>
                    <Answers disabled={busy || !canAnswer} onAnswer={(v) => void answer(v)} />
                    {!canAnswer && <p className="pl-card__far">{answered.has(target.mission.id) ? "Έχετε ήδη απαντήσει εδώ. Χρειάζεται ένας ακόμα δημότης." : `Απομακρυνθήκατε: ${distanceWords(target.distance, accuracy)}. Πλησιάστε ξανά για να απαντήσετε.`}</p>}
                    {cardNote && <p className="pl-card__note">{cardNote}</p>}
                    {busy && <p className="pl-card__note">Καταχώριση.</p>}
                    <button type="button" className="btn" onClick={openCamera}><CameraIcon weight="fill" className="btn__icon" aria-hidden="true" />Δείτε το με την κάμερα</button>
                    {canListen && canAnswer && (
                      <button type="button" className="btn" onClick={listen} disabled={listening || busy}><Microphone weight="fill" className="btn__icon" aria-hidden="true" />{listening ? "Σας ακούω: ναι, όχι ή δεν είμαι σίγουρος" : "Απαντήστε με τη φωνή"}</button>
                    )}
                  </>
                )}
              </div>
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>

      {/* A new level or a reward takes the screen, then the map comes back. */}
      <ModalOverlay isOpen={!!takeover} isKeyboardDismissDisabled className="pl-sheet">
        <Modal className="pl-sheet__modal">
          <Dialog className="pl-sheet__dialog" aria-label={takeover?.kind === "level" ? "Νέο επίπεδο" : "Νέο προνόμιο"}>
            {takeover?.kind === "level" && <LevelUp key={takeoverKey} name={takeover.name} next={takeover.next} onDone={nextTakeover} />}
            {takeover?.kind === "ticket" && (
              <Ticket key={takeoverKey} reward={takeover.rewards[0]!} others={takeover.rewards.length - 1} note={rewards?.note ?? FICTIONAL_NOTE}
                onDone={nextTakeover} onRewards={() => { nextTakeover(); setPanel("rewards"); }} />
            )}
          </Dialog>
        </Modal>
      </ModalOverlay>
    </div>
  );
}

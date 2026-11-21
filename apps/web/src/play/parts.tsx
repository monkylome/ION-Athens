/** The pieces of the game screen that are not the map: header, answers, stamp, ticket, rewards, list. */
import { useEffect, useRef, useState } from "react";
import { animate } from "motion";
import { motion, useReducedMotion } from "motion/react";
import { ArrowBendUpLeft, ArrowLeft, ArrowBendUpRight, ArrowDown, ArrowUp, Bank, Barricade, Check, DotsNine, Eye, List, Lock, Question, Ticket as TicketIcon, TrafficSignal, UsersThree, X, type Icon } from "@phosphor-icons/react";
import { ANSWER_LABELS, factKnown, factWords, kindOf, levelProgress, venueProgress, missionLine, nextReward, nextRewardLine, pointsObject, pointsWords, type AlbumTile, type Answer, type Discovery, type Kind, type Mission, type Nearby, type Neighbourhood, type Outcome, type Profile, type Reward, type Rewards, type Venue } from "./game";
import { distanceWords, directionWords } from "./geo";
import { feel } from "./feel";
import type { FakeWalk } from "./sensors";

/** A number that rolls to its new value in whole steps, with a tick for each. Instant under reduced motion. */
export function RollingNumber({ value, sound = false }: { value: number; sound?: boolean }) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  const reduced = useReducedMotion();
  useEffect(() => {
    const start = from.current;
    from.current = value;
    if (start === value) return;
    if (reduced) { setShown(value); return; }
    let last = start;
    const controls = animate(start, value, {
      duration: Math.min(1.1, 0.25 + Math.abs(value - start) * 0.035),
      ease: "linear",
      onUpdate: (v) => {
        const whole = Math.round(v);
        if (whole === last) return;
        last = whole;
        setShown(whole);
        if (sound) feel.count(Math.abs(whole - start));
      },
      onComplete: () => setShown(value),
    });
    return () => { controls.stop(); setShown(value); };
  }, [value, reduced, sound]);
  // Assistive technology gets the final number once, not every step.
  return <><span aria-hidden="true">{shown}</span><span className="visually-hidden">{value}</span></>;
}

/** Progress drawn as the tactile strip it is named after: a yellow band with black studs, hard-edged. */
export function Strip({ share }: { share: number }) {
  return <div className="pl-strip" aria-hidden="true"><div className="pl-strip__done" style={{ width: `${Math.round(Math.min(1, Math.max(0, share)) * 100)}%` }} /></div>;
}

const GLYPHS: Record<Kind, Icon> = { sound: TrafficSignal, tactile: DotsNine, obstacle: Barricade, crowd: UsersThree, place: Bank, other: Question };

/** What a mission is, as one sign: a signal, paving studs, a barrier, people, a building. Always beside words or a label. */
export function Glyph({ mission, className }: { mission: Pick<Mission, "type" | "venueId">; className?: string }) {
  const Sign = GLYPHS[kindOf(mission)];
  return <Sign weight="fill" className={className} aria-hidden="true" />;
}

/**
 * Top of the map: how far the points are from the next reward («20 / 50», a thin bar, a ticket), and the menu.
 * This is where the points roll up. The level, the album and what points are for live in the menu.
 */
export function Hud({ points, rewards, onMenu }: { points: number; rewards: Rewards | null; onMenu(): void }) {
  const next = rewards ? nextReward(rewards.rewards, points) : null;
  return (
    <header className="pl-hud">
      <p className="pl-progress">
        <TicketIcon weight="fill" className="pl-progress__icon" aria-hidden="true" />
        <span className="pl-progress__figure" aria-hidden="true"><RollingNumber value={points} sound />{next ? ` / ${next.reward.pointsRequired}` : ""}</span>
        <span className="pl-progress__bar" aria-hidden="true"><span style={{ width: `${Math.round((next ? next.progress : 1) * 100)}%` }} /></span>
        <span className="visually-hidden">{pointsWords(points)}. {rewards ? nextRewardLine(next) : ""}</span>
      </p>
      <button type="button" className="pl-hud__menu" id="menu-button" onClick={onMenu} aria-label="Μενού"><List weight="bold" aria-hidden="true" /></button>
    </header>
  );
}

/** In the menu: the level and its bar, and what the points are for. */
export function Standing({ profile, rewards }: { profile: Profile | null; rewards: Rewards | null }) {
  const points = profile?.points ?? 0;
  const next = rewards ? nextReward(rewards.rewards, points) : null;
  return (
    <div className="pl-standing">
      <p className="pl-standing__level"><span className="visually-hidden">Επίπεδο: </span>{profile?.level ?? "Νέος χαρτογράφος"}</p>
      <Strip share={profile ? levelProgress(profile) ?? 1 : 0} />
      <p>{pointsWords(points)}. {profile?.nextLevel ? `Επόμενο επίπεδο σε ${pointsObject(profile.nextLevel.pointsNeeded)}: ${profile.nextLevel.name}.` : "Τελευταίο επίπεδο."}</p>
      {rewards && <p>{nextRewardLine(next)}</p>}
    </div>
  );
}

/** A new level takes the whole screen for a moment, then the map comes back. */
export function LevelUp({ name, next, onDone }: { name: string; next: Profile["nextLevel"]; onDone(): void }) {
  const reduced = useReducedMotion();
  return (
    <div className="pl-levelup">
      <p className="pl-levelup__lead">Νέο επίπεδο</p>
      <motion.h2 className="pl-levelup__name" initial={reduced ? false : { scale: 1.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ duration: 0.14, ease: [0.7, 0, 1, 0.6] }}>{name}</motion.h2>
      <Strip share={1} />
      {next && <p className="pl-levelup__next">Επόμενο: {next.name}, σε {pointsObject(next.pointsNeeded)}.</p>}
      <button type="button" className="btn btn--primary btn--tall" data-on="accent" autoFocus onClick={onDone}>Συνέχεια</button>
    </div>
  );
}

/** «Το άλμπουμ μου»: what this device has stamped, by type, with empty slots for what is still to find. */
export function Album({ tiles, total, neighbourhood, venues, discoveries, onClose }: {
  tiles: readonly AlbumTile[];
  total: number;
  neighbourhood: Neighbourhood | null;
  /** The places this device has stamped, with how full their cards are now. */
  venues: readonly Venue[];
  /** What the scan mode found. */
  discoveries: readonly Discovery[];
  onClose(): void;
}) {
  const percent = neighbourhood && neighbourhood.total > 0 ? Math.round((1000 * neighbourhood.done) / neighbourhood.total) / 10 : null;
  return (
    <section className="pl-pane" aria-labelledby="album-title">
      <button type="button" className="btn btn--quiet pl-pane__close" onClick={onClose}><ArrowLeft weight="bold" className="btn__icon" aria-hidden="true" />Πίσω</button>
      <h1 id="album-title" tabIndex={-1}>Το άλμπουμ μου</h1>
      {neighbourhood && percent !== null && (
        <div className="pl-complete">
          <p className="pl-complete__figure">{String(percent).replace(".", ",")}%</p>
          <p className="pl-complete__name">{neighbourhood.name}: {neighbourhood.done} από {neighbourhood.total} σημεία στον χάρτη</p>
          <Strip share={neighbourhood.done / neighbourhood.total} />
        </div>
      )}
      <p className="pl-pane__lead">{total === 0 ? "Καμία σφραγίδα ακόμα." : total === 1 ? "Μία σφραγίδα." : `${total} σφραγίδες.`}</p>
      <ul className="pl-album">
        {tiles.map((t) => (
          <li key={t.type} className={`pl-tile${t.count === 0 ? " pl-tile--empty" : ""}`}>
            <Glyph mission={{ type: t.type }} className="pl-tile__glyph" />
            <span className="pl-tile__count">{t.count}</span>
            <span className="pl-tile__label">{t.label}</span>
            <span className="visually-hidden">{t.count === 0 ? "Κενή θέση: δεν έχετε βρει ακόμα." : `${t.confirmed} επιβεβαιωμένες.`}</span>
          </li>
        ))}
      </ul>
      {venues.length > 0 && <>
        <h2>Χώροι που ανοίξατε</h2>
        <ul className="pl-rewards">
          {venues.map((v) => {
            const fill = venueProgress(v);
            return (
              <li key={v.id} className="pl-reward pl-reward--unlocked">
                <p className="pl-reward__title">{v.name}</p>
                <p className="pl-reward__partner">{fill.known} από {fill.total} στοιχεία</p>
                <Strip share={fill.total ? fill.known / fill.total : 0} />
              </li>
            );
          })}
        </ul>
      </>}
      {discoveries.length > 0 && <>
        <h2>Ανακαλύψεις</h2>
        <ul className="pl-album">
          {discoveries.map((d) => <li key={d.id} className="pl-tile"><Eye weight="fill" className="pl-tile__glyph" aria-hidden="true" /><span className="pl-tile__label">{d.label} · {d.confirmed ? "Επιβεβαιώθηκε" : "Μία μαρτυρία"}</span></li>)}
        </ul>
      </>}
    </section>
  );
}

/** A lowered threshold is a rehearsal aid and is always said. */
function DemoThreshold({ reward }: { reward: Reward }) {
  if (reward.standardPointsRequired === undefined || reward.standardPointsRequired === reward.pointsRequired) return null;
  return <p className="pl-demo">Όριο επίδειξης: {reward.pointsRequired} αντί για {reward.standardPointsRequired} πόντους</p>;
}

/**
 * A place as a card that fills up: one slot per fact, empty until two citizens
 * agree. Answering a question about a place is opening it for everyone.
 */
export function VenueCard({ venue, currentKey, waiting }: { venue: Venue; currentKey?: string; waiting: ReadonlySet<string> }) {
  const { known, total } = venueProgress(venue);
  return (
    <div className="pl-venue">
      <p className="pl-venue__name">{venue.name}</p>
      <p className="pl-venue__count">{known} από {total} στοιχεία</p>
      <ol className="pl-venue__slots">
        {venue.facts.map((f) => {
          const state = factKnown(f) ? "known" : waiting.has(f.key) ? "waiting" : "unknown";
          const negative = f.value === "no" || f.value === false;
          return (
            <li key={f.key} className={`pl-slot pl-slot--${state}${f.key === currentKey ? " pl-slot--current" : ""}`}>
              {state === "known" ? (negative ? <X weight="bold" aria-hidden="true" /> : <Check weight="bold" aria-hidden="true" />) : state === "waiting" ? <span className="pl-slot__half" /> : null}
              <span className="visually-hidden">{f.question} {state === "known" ? factWords(f) : state === "waiting" ? "Μία απάντηση, χρειάζεται δεύτερη." : "Άγνωστο ακόμα."}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

const ANSWER_ICONS = { yes: Check, no: X, unsure: Question } as const;

/** The three answers. The same component on the card and over the camera. None is the "right" one, so none is yellow. */
export function Answers({ disabled, onAnswer }: { disabled: boolean; onAnswer(value: Answer): void }) {
  return (
    <div className="pl-answers" role="group" aria-label="Η απάντησή σας">
      {(["yes", "no", "unsure"] as const).map((value) => {
        const Icon = ANSWER_ICONS[value];
        return (
          <button key={value} type="button" className={`btn pl-answer pl-answer--${value}`} disabled={disabled} onClick={() => onAnswer(value)}>
            <Icon weight="bold" className="btn__icon" aria-hidden="true" />{ANSWER_LABELS[value]}
          </button>
        );
      })}
    </div>
  );
}

/** The answer moment: the stamp lands, the points roll, the card says what happened. */
export function Stamp({ outcome, earned, before, after }: { outcome: Outcome; earned: number; before: number; after: number }) {
  const reduced = useReducedMotion();
  const [total, setTotal] = useState(before);
  useEffect(() => {
    // The stamp first, then the count: one thing at a time.
    const timer = window.setTimeout(() => setTotal(after), reduced ? 0 : 420);
    return () => window.clearTimeout(timer);
  }, [after, reduced]);
  return (
    <div className="pl-moment">
      <motion.p
        lang="el"
        className={`pl-stamp t-alert-word${outcome.confirmed ? " pl-stamp--confirmed" : ""}`}
        initial={reduced ? false : { scale: 2.8, rotate: -16, opacity: 0 }}
        animate={{ scale: 1, rotate: -5, opacity: 1 }}
        transition={{ duration: 0.13, ease: [0.7, 0, 1, 0.6] }}
      >
        {outcome.stamp}
      </motion.p>
      <p className="pl-moment__points">
        <span className="pl-moment__earned">+{earned}</span>
        <span className="visually-hidden">{pointsWords(earned)}. </span>
        <span className="pl-moment__total">Σύνολο: <RollingNumber value={total} sound /> {after === 1 ? "πόντος" : "πόντοι"}</span>
      </p>
      <p className="pl-moment__line">{outcome.line}</p>
      {outcome.change && <p className="pl-moment__change">{outcome.change}</p>}
    </div>
  );
}

/** A reward as a ticket: white stock, black type, a perforation, a stub that tears off. */
export function Ticket({ reward, others, note, onDone, onRewards }: { reward: Reward; others: number; note: string; onDone(): void; onRewards(): void }) {
  const reduced = useReducedMotion();
  const [torn, setTorn] = useState(false);
  const tear = () => { setTorn(true); feel.tear(); };
  return (
    <div className="pl-ticketview">
      <p className="pl-ticketview__lead">{torn ? "Δικό σας." : "Ξεκλειδώσατε ένα προνόμιο."}</p>
      <div className="pl-ticket">
        <div className="pl-ticket__main">
          <p className="pl-ticket__partner">{reward.partner || "Δήμος Αθηναίων"}</p>
          <h2 className="pl-ticket__title">{reward.title}</h2>
        </div>
        <motion.div
          className={`pl-ticket__stub${torn ? " pl-ticket__stub--torn" : ""}`}
          animate={torn ? (reduced ? { opacity: 0 } : { y: [0, 14, 520], rotate: [0, 5, 16], opacity: [1, 1, 1] }) : { y: 0, rotate: 0, opacity: 1 }}
          transition={reduced ? { duration: 0 } : { duration: 0.55, times: [0, 0.25, 1], ease: "easeIn" }}
          aria-hidden={torn}
        >
          <span className="pl-ticket__cost">{reward.pointsRequired}</span>
          <span className="pl-ticket__unit">πόντοι</span>
        </motion.div>
      </div>
      <DemoThreshold reward={reward} />
      {others > 0 && <p className="pl-ticketview__others">Μαζί του {others === 1 ? "ξεκλειδώθηκε ένα ακόμα προνόμιο" : `ξεκλειδώθηκαν ${others} ακόμα προνόμια`}.</p>}
      <div className="stack">
        {torn
          ? <button type="button" className="btn btn--primary" data-on="accent" onClick={onDone}>Συνέχεια</button>
          : <button type="button" className="btn btn--primary btn--tall" data-on="accent" onClick={tear}>Κόψτε το κουπόνι</button>}
        <button type="button" className="btn btn--quiet" onClick={onRewards}>Όλα τα προνόμια</button>
      </div>
      <p className="pl-note">{note}</p>
    </div>
  );
}

export const FICTIONAL_NOTE = "Τα προνόμια προέρχονται από τη δοκιμαστική Κάρτα Αθηναίου του sandbox. Δεν αντιστοιχούν σε υπαρκτό πρόγραμμα του Δήμου.";

export function RewardsView({ rewards, points, onClose }: { rewards: Rewards | null; points: number; onClose(): void }) {
  const close = <button type="button" className="btn btn--quiet pl-pane__close" onClick={onClose}><ArrowLeft weight="bold" className="btn__icon" aria-hidden="true" />Πίσω</button>;
  if (!rewards) return <section className="pl-pane">{close}<h1 tabIndex={-1}>Προνόμια</h1><p>Τα προνόμια φορτώνουν.</p><p className="pl-note">{FICTIONAL_NOTE}</p></section>;
  const unlocked = rewards.rewards.filter((r) => r.pointsRequired <= points);
  const locked = rewards.rewards.filter((r) => r.pointsRequired > points);
  return (
    <section className="pl-pane" aria-labelledby="rewards-title">
      {close}
      <h1 id="rewards-title" tabIndex={-1}>Προνόμια</h1>
      <p className="pl-note">{rewards.note}</p>
      <p className="pl-pane__lead">Έχετε {pointsObject(points)}. {unlocked.length === 0 ? "Κανένα προνόμιο ακόμα." : unlocked.length === 1 ? "Ένα προνόμιο ξεκλειδωμένο." : `${unlocked.length} προνόμια ξεκλειδωμένα.`}</p>
      {unlocked.length > 0 && <>
        <h2>Ξεκλειδωμένα</h2>
        <ul className="pl-rewards">
          {unlocked.map((r) => (
            <li key={r.id} className="pl-reward pl-reward--unlocked">
              <p className="pl-reward__state"><Check weight="bold" className="btn__icon" aria-hidden="true" />Ξεκλειδώθηκε</p>
              <p className="pl-reward__title">{r.title}</p>
              <p className="pl-reward__partner">{r.partner}</p>
              <DemoThreshold reward={r} />
            </li>
          ))}
        </ul>
      </>}
      {locked.length > 0 && <>
        <h2>Επόμενα</h2>
        <ul className="pl-rewards">
          {locked.map((r) => (
            <li key={r.id} className="pl-reward">
              <p className="pl-reward__state"><Lock weight="bold" className="btn__icon" aria-hidden="true" />{r.pointsRequired - points === 1 ? "Χρειάζεται ακόμα 1 πόντος" : `Χρειάζονται ακόμα ${r.pointsRequired - points} πόντοι`}</p>
              <p className="pl-reward__title">{r.title}</p>
              <p className="pl-reward__partner">{r.partner}</p>
              <DemoThreshold reward={r} />
            </li>
          ))}
        </ul>
      </>}
      <p className="pl-note">{rewards.note}</p>
    </section>
  );
}

/**
 * «Κοντά σας»: the board as tiles, nearest first. Every mission is a real
 * button with its whole description as its name: this is the game for a
 * screen reader, and the quick way in for everyone else.
 */
export function NearTiles({ items, answered, heading, accuracyM, onOpen }: {
  items: readonly Nearby[];
  answered: ReadonlySet<string>;
  heading: number | null;
  accuracyM?: number;
  onOpen(n: Nearby): void;
}) {
  if (items.length === 0) return <p>Καμία ανοιχτή αποστολή εδώ γύρω.</p>;
  return (
    <ol className="pl-mlist">
      {items.map((n) => {
        const mine = answered.has(n.mission.id);
        const far = distanceWords(n.distance, accuracyM);
        return (
          <li key={n.mission.id}>
            <button type="button" data-mission-id={n.mission.id} className={`pl-mitem${n.reachable && !mine ? " pl-mitem--reach" : ""}`} onClick={() => onOpen(n)}
              aria-label={`${missionLine(n, heading, accuracyM)} ${mine ? "Έχετε ήδη απαντήσει." : n.reachable ? "" : "Πλησιάστε για να απαντήσετε."}`.trim()}>
              <span className="pl-mitem__sign">{mine ? <Check weight="bold" aria-hidden="true" /> : <Glyph mission={n.mission} />}</span>
              <span className="pl-mitem__text">
                <span className="pl-mitem__question">{n.mission.question}</span>
                <span className="pl-mitem__where">{[n.mission.where, far === "κοντά" ? "κοντά σας" : far, directionWords(n.bearing, heading)].filter(Boolean).join(", ")}</span>
              </span>
              <span className="pl-mitem__state">{mine ? "Έγινε" : n.reachable ? `+${n.mission.points}` : <ArrowUp weight="bold" aria-hidden="true" style={{ transform: `rotate(${heading === null ? n.bearing : n.bearing - heading}deg)` }} />}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** The presenter's arrows. On a stage nobody walks. */
export function FakePad({ walk }: { walk: FakeWalk }) {
  return (
    <div className="pl-pad" role="group" aria-label="Μετακίνηση της θέσης επίδειξης">
      <button type="button" className="pl-pad__key" onClick={walk.left} aria-label="Στροφή αριστερά"><ArrowBendUpLeft weight="bold" aria-hidden="true" /></button>
      <button type="button" className="pl-pad__key" onClick={walk.forward} aria-label="Ένα βήμα μπροστά"><ArrowUp weight="bold" aria-hidden="true" /></button>
      <button type="button" className="pl-pad__key" onClick={walk.back} aria-label="Ένα βήμα πίσω"><ArrowDown weight="bold" aria-hidden="true" /></button>
      <button type="button" className="pl-pad__key" onClick={walk.right} aria-label="Στροφή δεξιά"><ArrowBendUpRight weight="bold" aria-hidden="true" /></button>
    </div>
  );
}

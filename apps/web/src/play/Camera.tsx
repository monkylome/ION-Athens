/**
 * The catch. The live rear camera, full screen, with the mission standing in
 * the picture where the compass says it is. No AR library: a video element
 * and one flat yellow object, placed by the bearing to the mission minus the
 * phone's heading. The object is a pointer, not a judge: an answer is accepted
 * by distance, never by whether the object lines up with anything.
 *
 * The picture goes from the camera to this screen and nowhere else. No frame
 * is read, stored or sent.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";
import { ArrowLeft, ArrowRight, Cards, MapTrifold } from "@phosphor-icons/react";
import { CAMERA_FOV_DEG, platePlacement, shortDistance } from "./geo";
import type { Nearby, Outcome } from "./game";
import { Glyph } from "./parts";
import type { Heading } from "./sensors";

export const CAMERA_PRIVACY = "Η εικόνα μένει στο τηλέφωνο. Δεν καταγράφεται.";

/** Why the camera view cannot open, in words for the person. Null when it can be tried. */
export function cameraObstacle(heading: Heading): string | null {
  if (typeof window === "undefined") return null;
  if (!window.isSecureContext) return "Το πρόγραμμα περιήγησης δεν δίνει την κάμερα σε αυτή τη σύνδεση, γιατί δεν τη θεωρεί ασφαλή. Απαντήστε από την κάρτα.";
  if (!navigator.mediaDevices?.getUserMedia) return "Αυτό το πρόγραμμα περιήγησης δεν δίνει πρόσβαση στην κάμερα. Απαντήστε από την κάρτα.";
  if (heading.value === null) return "Η πυξίδα του τηλεφώνου δεν είναι διαθέσιμη, άρα η κάμερα δεν ξέρει πού να δείξει. Απαντήστε από την κάρτα.";
  return null;
}

export function Camera({ target, heading, fov = CAMERA_FOV_DEG, tag, caught, onCard, onLeave, onFail, onCalibrate, answers, after }: {
  target: Nearby;
  heading: Heading;
  fov?: number;
  /** The demo tag, shown over the video so nothing simulated looks live. */
  tag: ReactNode;
  /** The answer went through: the object locks and the stamp lands over the picture. */
  caught: { outcome: Outcome; earned: number } | null;
  /** To the card: the same question without the camera. */
  onCard(): void;
  /** Back to the map. */
  onLeave(): void;
  /** The camera could not start: the caller goes to the card with this sentence. */
  onFail(message: string): void;
  onCalibrate(): void;
  /** The three answers: the same ones as on the card. */
  answers: ReactNode;
  /** What follows a catch: the next question here, or back to the map. */
  after: ReactNode;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [live, setLive] = useState(false);
  const reduced = useReducedMotion();
  const fail = useRef(onFail);
  fail.current = onFail;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let closed = false;
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false }).then((s) => {
      if (closed) { s.getTracks().forEach((t) => t.stop()); return; }
      stream = s;
      const element = video.current;
      if (!element) return;
      element.srcObject = s;
      void element.play().then(() => setLive(true), () => setLive(true));
    }, (error: unknown) => {
      if (closed) return;
      const name = error instanceof DOMException ? error.name : "";
      fail.current(name === "NotAllowedError" || name === "SecurityError"
        ? "Η κάμερα δεν επιτρέπεται. Δεν χρειάζεται: απαντήστε από την κάρτα."
        : "Η κάμερα δεν άνοιξε σε αυτή τη συσκευή. Απαντήστε από την κάρτα.");
    });
    // Leaving the view switches the camera off at once.
    return () => { closed = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, []);

  const plate = heading.value === null ? null : platePlacement(target.bearing, heading.value, fov);
  const far = target.reachable ? "εδώ" : shortDistance(target.distance);
  // Caught: the object stops following the compass and locks in the middle of the picture.
  const x = caught ? 0.5 : plate?.x ?? 0.5;
  const shown = caught !== null || plate?.visible === true;

  return (
    <div className={`pl-cam${caught ? " pl-cam--caught" : ""}`}>
      <div className="pl-cam__view">
        <video ref={video} className="pl-cam__video" playsInline muted aria-hidden="true" />
        {!live && <p className="pl-cam__wait">Η κάμερα ανοίγει.</p>}
        <div className="pl-cam__bar">
          <button type="button" className="pl-cam__key" onClick={onLeave}><MapTrifold weight="fill" aria-hidden="true" />Χάρτης</button>
          {!caught && <button type="button" className="pl-cam__key" onClick={onCard}><Cards weight="fill" aria-hidden="true" />Χωρίς κάμερα</button>}
        </div>
        <div className="pl-cam__tag">{tag}</div>
        {shown && (
          <div className="pl-cam__object" style={{ left: `${x * 100}%` }} aria-hidden="true">
            <span className="pl-cam__head"><Glyph mission={target.mission} className="pl-cam__glyph" />+{target.mission.points}</span>
            <span className="pl-cam__far">{far}</span>
            <span className="pl-cam__stem" />
            {caught && <><span className="pl-cam__lock pl-cam__lock--a" /><span className="pl-cam__lock pl-cam__lock--b" /></>}
          </div>
        )}
        {!caught && plate && !plate.visible && (
          <div className={`pl-cam__turn pl-cam__turn--${plate.side}`} aria-hidden="true">
            {plate.side === "left" ? <ArrowLeft weight="bold" className="pl-cam__arrow" /> : <ArrowRight weight="bold" className="pl-cam__arrow" />}
            <span>{plate.side === "left" ? "Αριστερά" : "Δεξιά"}</span>
          </div>
        )}
        {caught && (
          <motion.p
            lang="el"
            className={`pl-stamp pl-cam__stamp t-alert-word${caught.outcome.confirmed ? " pl-stamp--confirmed" : ""}`}
            initial={reduced ? false : { scale: 3, rotate: -18, opacity: 0 }}
            animate={{ scale: 1, rotate: -6, opacity: 1 }}
            transition={{ duration: 0.13, ease: [0.7, 0, 1, 0.6] }}
          >
            {caught.outcome.stamp}
          </motion.p>
        )}
      </div>
      <div className="pl-cam__panel">
        {caught ? (
          <>
            <p className="pl-cam__earned">+{caught.earned}</p>
            <p className="pl-cam__line">{caught.outcome.line}</p>
            {caught.outcome.change && <p className="pl-cam__change">{caught.outcome.change}</p>}
            {after}
          </>
        ) : (
          <>
            <h2 className="pl-cam__question">{target.mission.question}</h2>
            {answers}
            <div className="pl-cam__foot">
              <p className="pl-cam__privacy">{CAMERA_PRIVACY}</p>
              <button type="button" className="pl-cam__key" onClick={onCalibrate}>Στρέψτε προς το σημείο και πατήστε</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

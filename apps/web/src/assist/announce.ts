import { useCallback, useRef, useState } from "react";
import { cancelSpeech, speak } from "../voice/speech";

/** One status line for the screen and the live region, spoken once per change. Silent with ?voice=off. */
export function useAnnouncer(speakAloud = true) {
  const [text, setText] = useState("");
  const last = useRef("");
  const say = useCallback((next: string) => {
    if (next === last.current) return;
    last.current = next;
    setText(next);
    if (speakAloud && new URLSearchParams(location.search).get("voice") !== "off") {
      cancelSpeech();
      speak(next, { priority: 1 });
    }
  }, [speakAloud]);
  return [text, say] as const;
}

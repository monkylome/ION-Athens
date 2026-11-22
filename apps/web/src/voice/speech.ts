type SpeechOptions = {
  priority?: number;
  onStart?: () => void;
  /** Character index of the word being spoken, when the voice reports it. */
  onBoundary?: (charIndex: number) => void;
  /** The sentence ended or failed. Not called for a sentence that a more urgent one cut off or dropped. */
  onEnd?: () => void;
  rate?: number;
};
type Entry = SpeechOptions & { text: string; priority: number };

export function greekVoice(engine: SpeechSynthesis): SpeechSynthesisVoice | null {
  const greek = engine.getVoices().filter(v => /^el(?:[-_]|$)/i.test(v.lang));
  return greek.find(v => v.lang.toLowerCase().replace("_", "-") === "el-gr") ?? greek[0] ?? null;
}

export function createSpeaker(engine: SpeechSynthesis) {
  const pending: Entry[] = [];
  let active: Entry | undefined;
  function next() {
    if (active) return;
    const entry = pending.shift();
    if (!entry) return;
    active = entry;
    const utterance = new SpeechSynthesisUtterance(entry.text);
    utterance.lang = "el-GR";
    utterance.voice = greekVoice(engine);
    if (entry.rate) utterance.rate = entry.rate;
    utterance.onstart = () => { if (active === entry) entry.onStart?.(); };
    utterance.onboundary = (event: SpeechSynthesisEvent) => { if (active === entry) entry.onBoundary?.(event.charIndex); };
    utterance.onend = utterance.onerror = () => {
      if (active !== entry) return;
      active = undefined;
      entry.onEnd?.();
      next();
    };
    engine.speak(utterance);
  }
  const say = (text: string, { priority = 0, ...rest }: SpeechOptions = {}) => {
    if (active && priority > active.priority) {
      active = undefined;
      engine.cancel();
      for (let i = pending.length - 1; i >= 0; i--) {
        if (pending[i]!.priority < priority) pending.splice(i, 1);
      }
    }
    pending.push({ text, priority, ...rest });
    pending.sort((a, b) => b.priority - a.priority);
    next();
  };
  /** Stop speaking and forget what was waiting. No callbacks fire. */
  say.cancel = () => {
    pending.length = 0;
    active = undefined;
    engine.cancel();
  };
  return say;
}
let speaker: ReturnType<typeof createSpeaker> | undefined;
/**
 * A local voice model on the presenting laptop (scripts/tts-serve, Piper el_GR on 127.0.0.1:8799), tried first
 * when the page itself is open on that machine: desktop Linux browsers often have no Greek voice at all.
 * Anywhere else, or when the server does not answer within a second and a half, the browser's own voice speaks.
 * No sentence leaves the machine either way.
 */
const LOCAL_VOICE = "http://127.0.0.1:8799/tts";
function localFirst(engine: SpeechSynthesis): SpeechSynthesis {
  const onThisMachine = ["127.0.0.1", "localhost"].includes(location.hostname) && !/Android|iPhone|iPad/i.test(navigator.userAgent);
  if (!onThisMachine || new URLSearchParams(location.search).get("voice") === "browser") return engine;
  let audio: HTMLAudioElement | undefined;
  let generation = 0;
  const adapter = {
    getVoices: () => engine.getVoices(),
    cancel: () => { generation++; audio?.pause(); audio = undefined; engine.cancel(); },
    speak: (utterance: SpeechSynthesisUtterance) => {
      const mine = ++generation;
      const done = (type: "end" | "error") => { if (mine === generation) { if (type === "end") utterance.onend?.call(utterance, new Event("end") as SpeechSynthesisEvent); else utterance.onerror?.call(utterance, new Event("error") as SpeechSynthesisErrorEvent); } };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      fetch(`${LOCAL_VOICE}?text=${encodeURIComponent(utterance.text)}`, { signal: controller.signal })
        .then(response => { clearTimeout(timer); if (!response.ok) throw new Error("no local voice"); return response.blob(); })
        .then(blob => {
          if (mine !== generation) return;
          const url = URL.createObjectURL(blob);
          audio = new Audio(url);
          if (utterance.rate) audio.playbackRate = utterance.rate;
          audio.onplay = () => { if (mine === generation) utterance.onstart?.call(utterance, new Event("start") as SpeechSynthesisEvent); };
          audio.onended = () => { URL.revokeObjectURL(url); done("end"); };
          audio.onerror = () => { URL.revokeObjectURL(url); done("error"); };
          return audio.play();
        })
        .catch(() => { clearTimeout(timer); if (mine === generation) engine.speak(utterance); });
    },
  };
  return adapter as unknown as SpeechSynthesis;
}
export function speak(text: string, options?: SpeechOptions) {
  if (!window.speechSynthesis) return;
  speaker ??= createSpeaker(localFirst(window.speechSynthesis));
  speaker(text, options);
}
export function cancelSpeech() {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  speaker ??= createSpeaker(localFirst(window.speechSynthesis));
  speaker.cancel();
}

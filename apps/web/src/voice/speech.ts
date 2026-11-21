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
export function speak(text: string, options?: SpeechOptions) {
  if (!window.speechSynthesis) return;
  speaker ??= createSpeaker(window.speechSynthesis);
  speaker(text, options);
}
export function cancelSpeech() {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  speaker ??= createSpeaker(window.speechSynthesis);
  speaker.cancel();
}

type SpeechOptions = { priority?: number; onStart?: () => void };
type Entry = { text: string; priority: number; onStart?: () => void };

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
    const greek = engine.getVoices().filter(v => /^el(?:-|$)/i.test(v.lang));
    utterance.voice = greek.find(v => v.lang.toLowerCase() === "el-gr") ?? greek[0] ?? null;
    utterance.onstart = () => { if (active === entry) entry.onStart?.(); };
    utterance.onend = utterance.onerror = () => {
      if (active !== entry) return;
      active = undefined;
      next();
    };
    engine.speak(utterance);
  }
  return (text: string, { priority = 0, onStart }: SpeechOptions = {}) => {
    if (active && priority > active.priority) {
      active = undefined;
      engine.cancel();
      for (let i = pending.length - 1; i >= 0; i--) {
        if (pending[i]!.priority < priority) pending.splice(i, 1);
      }
    }
    pending.push({ text, priority, onStart });
    pending.sort((a, b) => b.priority - a.priority);
    next();
  };
}
let speaker: ReturnType<typeof createSpeaker> | undefined;
export function speak(text: string, options?: SpeechOptions) {
  if (!window.speechSynthesis) return;
  speaker ??= createSpeaker(window.speechSynthesis);
  speaker(text, options);
}

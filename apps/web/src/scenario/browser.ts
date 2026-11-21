/** The browser side of the engine's ports: fetch, speech synthesis, the graph file. */
import { buildGraphIndex, type GraphIndex, type PedestrianGraph } from "@ion/core";
import graphUrl from "../../../../data/athens-centre.graph.json?url";
import placesJson from "../../../../data/places.json";
import { cancelSpeech, greekVoice, speak } from "../voice/speech";
import { wordDurations } from "./phrases";
import type { PlaceRecord } from "./places";
import type { ApiPort, ApiResult, SourceInfo, Utterance, VoicePort } from "./ports";

export const places = placesJson as PlaceRecord[];

let graph: Promise<{ graph: PedestrianGraph; index: GraphIndex }> | undefined;
/** The pedestrian graph, fetched and indexed once per tab. */
export function loadGraph(): Promise<{ graph: PedestrianGraph; index: GraphIndex }> {
  graph ??= fetch(graphUrl)
    .then((response) => {
      if (!response.ok) throw new Error(`graph: HTTP ${response.status}`);
      return response.json() as Promise<PedestrianGraph>;
    })
    .then((data) => ({ graph: data, index: buildGraphIndex(data) }));
  graph.catch(() => {
    graph = undefined;
  });
  return graph;
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<ApiResult<T>> {
  try {
    const response = await fetch("/api" + path, {
      method,
      ...(method === "POST" ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) } : {}),
      signal: AbortSignal.timeout(15000),
    });
    const data = (await response.json().catch(() => null)) as (T & { error?: { message?: string; code?: string } }) | null;
    // 5xx means the server, or the sandbox behind it, is not delivering: the screens fall back and say so.
    return {
      ok: response.ok && data !== null,
      status: response.status,
      data: response.ok ? data : null,
      unreachable: response.status >= 500 || (response.ok && data === null),
      method,
      path,
      ...(data?.error?.code ? { code: data.error.code } : {}),
      ...(data?.error?.message ? { message: data.error.message } : {}),
    };
  } catch {
    return { ok: false, status: 0, data: null, unreachable: true, method, path };
  }
}

export async function loadLoop(preset: string) {
  const response = await call<import("./types").TheatreLoop>("GET", "/demo/loop?preset=" + encodeURIComponent(preset));
  return response.data?.start && response.data?.obstacle && response.data?.crossing && response.data?.destination ? response.data : null;
}

export const browserApi: ApiPort = {
  venue: id => call("GET", "/venues/" + encodeURIComponent(id)),
  destination: (text, location) => call("POST", "/destination", { text, ...(location ? { location } : {}) }),
  route: (from, to, profile) => call("POST", "/route", { from, to, profile }),
  report: (input) => call("POST", "/reports", input),
  demoConfirm: id => call("POST", "/demo/missions/" + encodeURIComponent("obstacle_check:" + id) + "/answer",
    {participant: "stage-witness-" + Math.random().toString(36).slice(2), answer: "yes"}),
  confirm: (id) => call("POST", `/reports/${encodeURIComponent(id)}/confirm`),
  resolve: (id) => call("POST", `/demo/resolve/${encodeURIComponent(id)}`),
  reset: () => call("POST", "/demo/reset"),
};

export async function fetchSources(): Promise<SourceInfo[] | null> {
  const result = await call<{ sources?: SourceInfo[] }>("GET", "/sources");
  return result.ok && Array.isArray(result.data?.sources) ? result.data.sources : null;
}

export const SPEECH_RATE = 1.05;

/**
 * Speech with captions. With a Greek voice the browser speaks and the words
 * follow its boundary events (or a timer when it sends none). Without one,
 * nothing is spoken, the words are timed, and `voiced` is false so the screen
 * can say "ΧΩΡΙΣ ΦΩΝΗ".
 */
export function browserVoice(enabled: () => boolean = () => true): VoicePort {
  let token = 0;
  let timers: number[] = [];
  const clear = () => {
    timers.forEach((t) => window.clearTimeout(t));
    timers = [];
  };
  const hasVoice = () => typeof window !== "undefined" && !!window.speechSynthesis && !!greekVoice(window.speechSynthesis);
  // Chrome fills the voice list late: ask early.
  if (typeof window !== "undefined" && window.speechSynthesis) window.speechSynthesis.getVoices();

  function timed(u: Utterance, mine: number, from: number, announceStart: boolean, endToo: boolean) {
    const durations = wordDurations(u.text, SPEECH_RATE);
    if (announceStart) u.onStart?.({ voiced: false });
    let at = 0;
    durations.forEach((ms, i) => {
      if (i >= from) timers.push(window.setTimeout(() => token === mine && u.onWord?.(i), at));
      at += ms;
    });
    if (endToo) timers.push(window.setTimeout(() => token === mine && u.onEnd?.(), at + 200));
    return at;
  }

  return {
    say(u) {
      const mine = ++token;
      clear();
      if (u.leadMs) timers.push(window.setTimeout(() => token === mine && begin(u, mine), u.leadMs));
      else begin(u, mine);
    },
    cancel() {
      token++;
      clear();
      cancelSpeech();
    },
  };

  function begin(u: Utterance, mine: number) {
    {
      if (!enabled() || !hasVoice()) {
        if (u.urgent) cancelSpeech();
        timed(u, mine, 0, true, true);
        return;
      }
      const starts: number[] = [];
      u.text.replace(/\S+/gu, (word, offset: number) => {
        starts.push(offset);
        return word;
      });
      let started = false;
      let ended = false;
      let boundaries = false;
      const end = () => {
        if (ended || token !== mine) return;
        ended = true;
        clear();
        u.onEnd?.();
      };
      if (u.urgent) cancelSpeech();
      speak(u.text, {
        priority: u.urgent ? 2 : 1,
        rate: SPEECH_RATE,
        onStart: () => {
          if (token !== mine || started) return;
          started = true;
          clear();
          u.onStart?.({ voiced: true });
          // Until the voice reports a word boundary, time the words. Then end no later than three times the estimate.
          const estimate = timed(u, mine, 1, false, false);
          timers.push(window.setTimeout(end, estimate * 3 + 4000));
        },
        onBoundary: (charIndex) => {
          if (token !== mine) return;
          if (!boundaries) {
            boundaries = true;
            const watchdog = timers.pop();
            clear();
            if (watchdog !== undefined) timers.push(watchdog);
          }
          let index = 0;
          for (let i = 0; i < starts.length; i++) if (starts[i]! <= charIndex) index = i;
          u.onWord?.(index);
        },
        onEnd: end,
      });
      // A voice that never starts (blocked before a gesture, or a broken engine): show the words anyway.
      timers.push(
        window.setTimeout(() => {
          if (token !== mine || started) return;
          started = true;
          cancelSpeech();
          timed(u, mine, 0, true, true);
        }, 2500),
      );
    }
  }
}

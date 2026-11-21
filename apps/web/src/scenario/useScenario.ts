/**
 * The scenario in React. `/stage` hosts the engine. `/phone` follows a host in
 * another tab of the same browser, and hosts by itself when there is none.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { synth } from "../sound/synth";
import { browserApi, browserVoice, loadGraph, places } from "./browser";
import { configFromSearch } from "./config";
import { initialState, ScenarioEngine } from "./engine";
import { hostLink } from "./link";
import { broadcastTransport, type Transport } from "./transport";
import type { Command, ScenarioState, ServerEvent } from "./types";

const STREAM_EVENTS = ["snapshot", "obstacle_added", "obstacle_changed", "obstacle_removed", "mission_answered", "map_updated"] as const;

export interface Scenario {
  state: ScenarioState;
  dispatch: (command: Command) => void;
  /** host: this tab runs the engine. follower: another tab does. */
  mode: "pending" | "host" | "follower";
  /** Set when the graph could not be loaded. */
  problem: string | null;
}

export interface ScenarioOptions {
  /** Steps and cane while walking. */
  walkingSound?: () => boolean;
}

function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function useScenario(surface: "stage" | "phone", options: ScenarioOptions = {}): Scenario {
  const [state, setState] = useState<ScenarioState>(() => initialState(configFromSearch(window.location.search)));
  const [mode, setMode] = useState<Scenario["mode"]>(surface === "stage" ? "host" : "pending");
  const [problem, setProblem] = useState<string | null>(null);
  const engine = useRef<ScenarioEngine | null>(null);
  const transport = useRef<Transport | null>(null);
  const id = useRef(newId());
  const walkingSound = useRef(options.walkingSound);
  walkingSound.current = options.walkingSound;

  // One channel for the life of the page.
  useEffect(() => {
    const channel = broadcastTransport();
    transport.current = channel;
    if (!channel) {
      setMode("host");
      return;
    }
    let decided = surface === "stage";
    let hostId: string | null = null;
    const off = channel.subscribe((message) => {
      if (message.from === id.current) return;
      if (message.t === "state") {
        // The stage always hosts. A phone that was hosting alone yields to it.
        if (surface === "phone" && (message.role === "stage" || !decided || hostId === message.from)) {
          decided = true;
          hostId = message.from;
          setMode("follower");
          setState(message.state);
        }
      } else if (message.t === "bye" && message.from === hostId) {
        hostId = null;
        setMode("host");
      }
    });
    let timer: number | undefined;
    if (surface === "phone") {
      channel.post({ t: "hello", from: id.current });
      timer = window.setTimeout(() => {
        if (!decided) {
          decided = true;
          setMode("host");
        }
      }, 600);
    }
    return () => {
      window.clearTimeout(timer);
      off();
      channel.close();
      transport.current = null;
    };
  }, [surface]);

  // The engine, only while this tab hosts.
  useEffect(() => {
    if (mode !== "host") return;
    let disposed = false;
    let cleanup = () => undefined as void;
    const query = new URLSearchParams(window.location.search);
    const config = configFromSearch(window.location.search);
    loadGraph().then(
      ({ index }) => {
        if (disposed) return;
        const voice = browserVoice(() => query.get("voice") !== "off");
        const instance = new ScenarioEngine(
          {
            index,
            places,
            api: browserApi,
            voice,
            now: () => performance.now(),
            wallNow: () => Date.now(),
            soundOn: () => synth.audible,
            effect(effect) {
              if (effect.type === "earcon") synth.earcon(effect.name);
              else if (effect.type === "turn_sound") synth.turn(effect.toRight);
              else synth.setWalking(effect.on && (walkingSound.current?.() ?? true));
            },
          },
          config,
        );
        try {
          const profile = localStorage.getItem("ion-walk-profile");
          if (profile === "quiet" || profile === "wheels") void instance.dispatch({ type: "chooseProfile", profile });
        } catch { /* Storage is optional. */ }
        engine.current = instance;
        // For rehearsal and automated checks: read the live state from the console.
        (window as unknown as { __ionScenario?: ScenarioEngine }).__ionScenario = instance;
        const channel = transport.current;
        const link = channel ? hostLink(channel, id.current, surface, (command) => void instance.dispatch(command), () => instance.getState()) : null;
        const off = instance.subscribe((next) => {
          setState(next);
          link?.publish(next);
        });
        setState(instance.getState());
        link?.publish(instance.getState());
        const timer = window.setInterval(() => instance.tick(), 50);

        let stream: EventSource | null = null;
        if (typeof EventSource !== "undefined") {
          stream = new EventSource("/api/events");
          stream.onopen = () => instance.streamStatus(true);
          stream.onerror = () => instance.streamStatus(false);
          for (const type of STREAM_EVENTS) {
            stream.addEventListener(type, (message: MessageEvent<string>) => {
              try {
                instance.serverEvent({ ...JSON.parse(message.data), type } as ServerEvent);
              } catch {
                /* a malformed event changes nothing */
              }
            });
          }
        }
        cleanup = () => {
          window.clearInterval(timer);
          stream?.close();
          off();
          link?.close();
          voice.cancel();
          synth.setWalking(false);
          engine.current = null;
        };
      },
      (error: unknown) => {
        if (!disposed) setProblem(error instanceof Error ? error.message : "Ο χάρτης πεζών δεν φορτώθηκε.");
      },
    );
    return () => {
      disposed = true;
      cleanup();
    };
  }, [mode, surface]);

  const dispatch = useCallback((command: Command) => {
    if (engine.current) void engine.current.dispatch(command);
    else transport.current?.post({ t: "command", from: id.current, command });
  }, []);

  return { state, dispatch, mode, problem };
}

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

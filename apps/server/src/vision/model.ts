/** The local vision model. Only the Ollama chat API is spoken here; the image goes to the local runtime and nowhere else. */
import { MODEL_SCHEMA, SYSTEM_PROMPT, USER_PROMPT } from "./vocab.ts";

export interface VisionModel {
  readonly name: string;
  /** Returns what the model said, parsed as JSON. Throws ModelError. */
  detect(imageBase64: string, signal: AbortSignal): Promise<unknown>;
  /** True when the runtime answers and has the model. */
  ping(signal: AbortSignal): Promise<boolean>;
}

export class ModelError extends Error {
  constructor(readonly code: "unavailable" | "invalid_output" | "timeout", message: string) {
    super(message);
  }
}

export class OllamaModel implements VisionModel {
  constructor(readonly baseUrl: string, readonly name: string, private readonly fetchFn: typeof fetch = fetch) {}

  async detect(imageBase64: string, signal: AbortSignal): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchFn(new URL("/api/chat", this.baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal,
        body: JSON.stringify({
          model: this.name,
          stream: false,
          format: MODEL_SCHEMA,
          keep_alive: "30m",
          options: { temperature: 0, num_predict: 300, num_ctx: 4096 },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: USER_PROMPT, images: [imageBase64] },
          ],
        }),
      });
    } catch (err) {
      if (signal.aborted) throw new ModelError("timeout", "timeout");
      throw new ModelError("unavailable", `fetch failed: ${(err as Error).message}`);
    }
    if (!res.ok) throw new ModelError("unavailable", `model runtime answered ${res.status}`);
    let content: string;
    try {
      content = ((await res.json()) as { message?: { content?: string } }).message?.content ?? "";
    } catch {
      if (signal.aborted) throw new ModelError("timeout", "timeout");
      throw new ModelError("invalid_output", "runtime body was not JSON");
    }
    try {
      return JSON.parse(content);
    } catch {
      throw new ModelError("invalid_output", "model output was not JSON");
    }
  }

  async ping(signal: AbortSignal): Promise<boolean> {
    try {
      const res = await this.fetchFn(new URL("/api/tags", this.baseUrl), { signal });
      if (!res.ok) return false;
      const body = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
      return (body.models ?? []).some((m) => m.name === this.name || m.model === this.name);
    } catch {
      return false;
    }
  }
}

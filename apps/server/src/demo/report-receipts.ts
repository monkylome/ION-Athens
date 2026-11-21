// The shared sandbox key cannot prove which reports belong to this rehearsal.
// Keep the ids returned by createReport. A managed API keeps them across restarts.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

export function reportReceipts(path?: string) {
  const scope = createHash("sha256").update(JSON.stringify([process.env.SANDBOX, process.env.SANDBOX_KEY])).digest("hex");
  const file = path && path + "-" + scope + ".json";
  const ids = new Set<string>(file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : []);
  function save() {
    if (!file) return;
    writeFileSync(file + ".tmp", JSON.stringify([...ids]), { mode: 0o600 });
    renameSync(file + ".tmp", file);
  }
  return {
    ids,
    add(id: string) { ids.add(id); save(); },
    forget(id: string) { if (ids.delete(id)) save(); },
  };
}

/** Keep the screen awake during a call, where the browser allows it. */
export async function keepAwake(): Promise<() => void> {
  const nav = navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> } };
  let lock: { release(): Promise<void> } | null = null;
  let wanted = true;
  const take = async () => {
    try { lock = (await nav.wakeLock?.request("screen")) ?? null; } catch { lock = null; }
  };
  const again = () => { if (wanted && document.visibilityState === "visible") void take(); };
  document.addEventListener("visibilitychange", again);
  await take();
  return () => {
    wanted = false;
    document.removeEventListener("visibilitychange", again);
    void lock?.release().catch(() => undefined);
  };
}

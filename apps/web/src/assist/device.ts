/** A random id made on this device. Not a name, not an account. */
function randomId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

function stored(key: string): string {
  try {
    const previous = localStorage.getItem(key);
    if (previous && /^[A-Za-z0-9_-]{8,64}$/.test(previous)) return previous;
    const id = randomId();
    localStorage.setItem(key, id);
    return id;
  } catch {
    return randomId();
  }
}

/** The person who asks for help. */
export const personDevice = () => stored("ion-assist-device");
/** The helper is the same participant as in the citizen missions, so points land on one profile. */
export const helperDevice = () => stored("ion-participant");

/** Where the same page is reachable over HTTPS, for a phone that opened it over plain HTTP. */
export function secureAddress(): string | null {
  if (window.isSecureContext || location.protocol === "https:") return null;
  return `https://${location.host}${location.pathname}`;
}

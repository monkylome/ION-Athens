/** What to tell a person, in Greek, when the phone refuses something. Always with a way forward. */
export interface Problem {
  title: string;
  steps: string[];
  /** The label of the one button that tries again. */
  retry: string;
}

export function mediaProblem(error: unknown, who: "person" | "helper"): Problem {
  const name = error instanceof DOMException ? error.name : "";
  const retry = "Δοκιμάστε ξανά";
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    return {
      title: "Η κάμερα χρειάζεται ασφαλή σύνδεση.",
      steps: [`Ανοίξτε τη σελίδα με διεύθυνση που αρχίζει από https://.`, "Αν εμφανιστεί προειδοποίηση για το πιστοποιητικό, επιλέξτε «Για προχωρημένους» και «Συνέχεια»."],
      retry,
    };
  }
  if (name === "NotAllowedError" || name === "SecurityError") {
    return {
      title: who === "person" ? "Δεν επιτράπηκε η κάμερα ή το μικρόφωνο." : "Δεν επιτράπηκε το μικρόφωνο.",
      steps: [
        "Πατήστε το εικονίδιο δίπλα στη διεύθυνση της σελίδας.",
        who === "person" ? "Επιτρέψτε την κάμερα και το μικρόφωνο." : "Επιτρέψτε το μικρόφωνο.",
        "Μετά πατήστε «Δοκιμάστε ξανά».",
      ],
      retry,
    };
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return {
      title: who === "person" ? "Δεν βρέθηκε κάμερα ή μικρόφωνο σε αυτή τη συσκευή." : "Δεν βρέθηκε μικρόφωνο σε αυτή τη συσκευή.",
      steps: ["Συνδέστε ένα μικρόφωνο ή χρησιμοποιήστε άλλη συσκευή.", "Μετά πατήστε «Δοκιμάστε ξανά»."],
      retry,
    };
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return {
      title: "Η κάμερα ή το μικρόφωνο χρησιμοποιείται από άλλη εφαρμογή.",
      steps: ["Κλείστε την άλλη εφαρμογή που τα χρησιμοποιεί.", "Μετά πατήστε «Δοκιμάστε ξανά»."],
      retry,
    };
  }
  return { title: "Δεν μπόρεσα να ανοίξω την κάμερα ή το μικρόφωνο.", steps: ["Ξαναφορτώστε τη σελίδα.", "Μετά πατήστε «Δοκιμάστε ξανά»."], retry };
}

export const locationProblem = (): Problem => ({
  title: "Δεν έχω τη θέση σας.",
  steps: [
    "Χρειάζομαι τη θέση σας για να βρω δημότη κοντά σας.",
    "Ενεργοποιήστε την τοποθεσία στη συσκευή και επιτρέψτε την στη σελίδα.",
    "Μετά πατήστε «Δοκιμάστε ξανά».",
  ],
  retry: "Δοκιμάστε ξανά",
});

export const unsupportedProblem = (): Problem => ({
  title: "Αυτός ο περιηγητής δεν υποστηρίζει κλήση με εικόνα.",
  steps: ["Ανοίξτε τη σελίδα με Chrome ή Safari στο τηλέφωνο."],
  retry: "Δοκιμάστε ξανά",
});

export function getPosition(timeoutMs = 10_000): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("no geolocation"));
    navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30_000 });
  });
}

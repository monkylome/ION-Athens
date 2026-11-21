export const labels = {
  turn_left: "Στροφή αριστερά", turn_right: "Στροφή δεξιά",
  obstacle_ahead: "Εμπόδιο μπροστά", arrived: "Άφιξη", attention: "Προσοχή",
};
export type Signal = keyof typeof labels;
export interface OutputDevice { signal(value: Signal): Promise<boolean> }
export interface InputDevice { subscribe(listener: () => void): () => void }

export const patterns: Record<Signal, number[]> = {
  turn_left: [120], turn_right: [120, 120, 120],
  obstacle_ahead: [420, 120, 420], attention: [420, 120, 420], arrived: [650],
};
export const phone: OutputDevice = {
  async signal(value) { return navigator.vibrate?.(patterns[value]) ?? false; },
};

export class Simulation implements InputDevice, OutputDevice {
  private listeners = new Set<() => void>();
  constructor(private display: (signal: Signal, at: Date) => void) {}
  async signal(value: Signal) { this.display(value, new Date()); return true; }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  detectNearbyObject() { this.listeners.forEach(listener => listener()); }
}

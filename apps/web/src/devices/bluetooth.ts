import type { OutputDevice, Signal } from "./signals";

export const uartService = "6e400001-b5a3-f393-e0a9-e50e24dcca9e";
export const uartRx = "6e400002-b5a3-f393-e0a9-e50e24dcca9e";
export const bytes: Record<Signal, number> = { turn_left: 1, turn_right: 2, obstacle_ahead: 3, arrived: 4, attention: 5 };
interface Characteristic {
  properties: { write: boolean; writeWithoutResponse: boolean };
  writeValueWithResponse(data: Uint8Array): Promise<void>;
  writeValueWithoutResponse(data: Uint8Array): Promise<void>;
}
interface Peripheral extends EventTarget {
  gatt?: {
    connect(): Promise<{ getPrimaryService(id: string): Promise<{ getCharacteristic(id: string): Promise<Characteristic> }> }>;
    disconnect(): void;
  };
}
interface Bluetooth { requestDevice(options: { filters: { services: string[] }[] }): Promise<Peripheral> }
export type State = "idle" | "connecting" | "ready" | "unsupported" | "cancelled" | "disconnected" | "failed";

export class BluetoothOutput implements OutputDevice {
  private device?: Peripheral;
  private output?: Characteristic;
  private generation = 0;
  constructor(private notify: (state: State) => void) {}
  private lost = () => { this.disconnect(); this.notify("disconnected"); };
  disconnect() {
    this.generation++;
    this.device?.removeEventListener("gattserverdisconnected", this.lost);
    this.device?.gatt?.disconnect();
    this.device = undefined;
    this.output = undefined;
  }
  async connect(service: string, characteristic: string) {
    this.disconnect();
    const attempt = this.generation;
    const bluetooth = (navigator as Navigator & { bluetooth?: Bluetooth }).bluetooth;
    if (!bluetooth) { this.notify("unsupported"); return; }
    this.notify("connecting");
    try {
      const device = await bluetooth.requestDevice({ filters: [{ services: [service] }] });
      if (this.generation !== attempt) return;
      this.device = device;
      device.addEventListener("gattserverdisconnected", this.lost);
      const server = await device.gatt?.connect();
      if (!server) throw new Error("GATT unavailable");
      if (this.generation !== attempt) { device.gatt?.disconnect(); return; }
      const output = await (await server.getPrimaryService(service)).getCharacteristic(characteristic);
      if (this.generation !== attempt) return;
      if (!output.properties.write && !output.properties.writeWithoutResponse) throw new Error("Read-only characteristic");
      this.output = output;
      this.notify("ready");
    } catch (error) {
      if (this.generation !== attempt) return;
      this.disconnect();
      this.notify(error instanceof Error && error.name === "NotFoundError" ? "cancelled" : "failed");
    }
  }
  async signal(value: Signal) {
    const output = this.output;
    if (!output) return false;
    try {
      const data = Uint8Array.of(bytes[value]);
      if (output.properties.write) await output.writeValueWithResponse(data);
      else await output.writeValueWithoutResponse(data);
      return true;
    } catch {
      if (this.output === output) this.lost();
      return false;
    }
  }
}

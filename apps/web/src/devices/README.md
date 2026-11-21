# Device signals

Open **Τηλέφωνο → Ρυθμίσεις συσκευής**. Phone vibration calls the browser's vibration API. Bluetooth requires a compatible browser, HTTPS or localhost, a user gesture and an advertising peripheral. The stage simulator displays each signal with its time. Its proximity input creates a proposal. Only the explicit confirmation button submits a report with the user's current location.

An output implements `OutputDevice.signal(value)` and resolves to whether the signal was sent. The phone uses milliseconds alternating vibration and silence. BLE writes one unsigned byte per signal to Nordic UART RX (service `6e400001-b5a3-f393-e0a9-e50e24dcca9e`, characteristic `6e400002-b5a3-f393-e0a9-e50e24dcca9e` by default). Both UUIDs can be changed in settings.

| Signal | Byte | Pattern (ms) |
| --- | --- | --- |
| turn_left | 1 | 120 |
| turn_right | 2 | 120, 120, 120 |
| obstacle_ahead | 3 | 420, 120, 420 |
| arrived | 4 | 650 |
| attention | 5 | 420, 120, 420 |

On an ESP32 using MicroPython with aioble, register a service and writable RX characteristic as below. In the application loop advertise the service UUID, wait for a central to connect, and consume writes while connected. The hardware-specific motor driver implements play_signal using the table above.

```python
service = aioble.Service(bluetooth.UUID(SERVICE_UUID))
rx = aioble.Characteristic(service, bluetooth.UUID(RX_UUID), write=True, capture=True)
aioble.register_services(service)
# Inside the connected coroutine:
connection, data = await rx.written()
if len(data) == 1 and 1 <= data[0] <= 5:
    play_signal(data[0])
```

The input contract is a subscription to a nearby-object detection and returns an unsubscribe function. Only the simulator currently produces detections. No real cane or glasses have been tested.

# ION Athens web app

## Running it on two devices (help by camera)

A phone can use its camera only on `https://` (or on `localhost`). `dev:lan` serves the app on every network
interface over HTTPS with a self-signed certificate (`@vitejs/plugin-basic-ssl`). The plain `npm run dev` is unchanged.

1. Put the laptop and the phone on the same Wi-Fi network. Find the laptop's address, for example `192.168.1.20`.
2. Start the server from the repository root: `npm run server` (port 8787).
3. Start the web app on all interfaces: `npm run dev:lan --workspace @ion/web`. It prints `Network: https://<laptop address>:5173/`.
   To use another server port: `ION_API_PORT=8791 npm run dev:lan --workspace @ion/web -- --port 5181`.
4. On the phone open `https://<laptop address>:5173/phone/help`. The browser warns about the certificate:
   choose "Advanced", then "Proceed". Allow the camera, the microphone and the location when asked.
5. On the laptop open `https://<laptop address>:5173/missions/help` (or `https://localhost:5173/missions/help`),
   accept the same warning, allow the microphone, and accept the request that appears.
6. The phone follows the stage on another screen with `?room=NAME`: open `/stage?room=demo` on the laptop and
   `/phone?room=demo` on the phone. Without `?room` the two screens talk only inside one browser, as before.

The call goes straight between the two devices (WebRTC, host candidates plus a public STUN server, configurable
with `VITE_ICE_SERVERS`, a JSON list). The server relays only the small signalling messages and stores nothing:
no video, no audio, no recording. If the laptop firewall blocks port 5173, open it for the local network.

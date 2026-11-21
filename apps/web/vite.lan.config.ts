/** Same as vite.config.ts, served on every network interface over HTTPS so a phone can use its camera. */
import basicSsl from "@vitejs/plugin-basic-ssl";
import base from "./vite.config";

export default {
  ...base,
  plugins: [...base.plugins, basicSsl()],
  server: { ...base.server, host: true },
};

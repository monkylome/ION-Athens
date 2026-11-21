import react from "@vitejs/plugin-react";

const apiPort = process.env.ION_API_PORT ?? "8787";
export default {
  plugins: [react()],
  server: { proxy: { "/api": { target: `http://localhost:${apiPort}` } } },
};

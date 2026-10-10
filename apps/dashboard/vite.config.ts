import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  server: {
    host: "127.0.0.1", port: 5173, strictPort: true,
    fs: {
      allow: [fileURLToPath(new URL(".", import.meta.url))],
      deny: [".env", ".env.*", "**/*.pem", "**/*.key", "**/*.crt", "**/.local/**", "**/wallet*.json", "**/.git/**"],
    },
    proxy: { "/api": { target: "http://127.0.0.1:3001", changeOrigin: true } },
  },
  esbuild: { jsx: "automatic" },
});

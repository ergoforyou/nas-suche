import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Entwicklung: `python -m agentur_pdf --nur-dienst --port 8765 --token dev`
// und `npm run dev` → http://localhost:5173/#t=dev
export default defineConfig({
  plugins: [react()],
  base: "./",
  server: { proxy: { "/api": "http://127.0.0.1:8765" } },
  build: { outDir: "dist", sourcemap: false, chunkSizeWarningLimit: 800 },
});

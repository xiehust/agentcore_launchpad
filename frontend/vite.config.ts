import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  // LAUNCHPAD_API lets a worktree/dev instance point at its own backend port
  const env = loadEnv(mode, ".", "LAUNCHPAD_");
  return {
    plugins: [react()],
    server: {
      proxy: {
        "/api": env.LAUNCHPAD_API ?? "http://localhost:8000",
      },
    },
  };
});

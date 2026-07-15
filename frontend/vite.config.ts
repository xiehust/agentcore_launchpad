import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  // LAUNCHPAD_API lets a worktree/dev instance point at its own backend port
  const env = loadEnv(mode, ".", "LAUNCHPAD_");
  const apiTarget = env.LAUNCHPAD_API ?? "http://localhost:8000";
  const proxy = {
    "/api": apiTarget,
  };

  return {
    plugins: [react()],
    server: {
      proxy,
    },
    preview: {
      proxy,
    },
  };
});

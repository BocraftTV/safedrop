import { defineConfig } from "vite";

export default defineConfig({
  // GitHub Pages deploys to /REPO-NAME/ — set this to your repo name.
  // If your repo is named "securedrop", keep this as-is.
  // If you use a custom domain or username.github.io repo, set to "/".
  base: process.env.GITHUB_PAGES_BASE ?? "/",
  build: {
    target: "esnext",
  },
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});

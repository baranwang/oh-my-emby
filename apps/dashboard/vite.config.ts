import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { paraglideVitePlugin } from "@inlang/paraglide-js"
import { TanStackRouterVite } from "@tanstack/router-plugin/vite"
import { defineConfig } from "vitest/config"

export default defineConfig({
  base: "/dashboard/",
  plugins: [
    TanStackRouterVite({ target: "react", autoCodeSplitting: true }),
    paraglideVitePlugin({
      project: "./project.inlang",
      outdir: "./src/paraglide",
      emitTsDeclarations: true,
      strategy: ["localStorage", "preferredLanguage", "baseLocale"]
    }),
    react(),
    tailwindcss()
  ],
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname
    }
  },
  test: {
    environment: "jsdom"
  }
})

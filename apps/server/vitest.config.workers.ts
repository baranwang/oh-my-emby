import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers"
import { defineConfig } from "vitest/config"

export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      main: "./test/workers-test-entry.ts",
      miniflare: {
        // The pool's bundled workerd currently supports dates through 2026-08-22.
        compatibilityDate: "2026-08-22",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB"],
        serviceBindings: {
          ASSETS: async (request) => {
            const pathname = new URL(request.url).pathname
            if (pathname === "/index.html") {
              return new Response("<main>dashboard</main>", {
                headers: { "content-type": "text/html; charset=utf-8" }
              })
            }
            if (pathname === "/assets/app.js") {
              return new Response("console.log('dashboard')", {
                headers: { "content-type": "application/javascript" }
              })
            }
            return new Response("Not Found", {
              status: 404,
              headers: { "content-type": "text/plain; charset=utf-8" }
            })
          }
        },
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(`${import.meta.dirname}/migrations`)
        }
      }
    })
  ],
  test: {
    include: [
      "test/d1-repository.test.ts",
      "test/workers-routing.test.ts",
      "test/workers-pbkdf2-benchmark.test.ts"
    ],
    setupFiles: ["./test/workers-setup.ts"]
  }
}))

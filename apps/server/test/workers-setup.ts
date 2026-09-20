import { env } from "cloudflare:workers"
import { applyD1Migrations } from "cloudflare:test"

const migrations = (env as typeof env & {
  readonly TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1]
}).TEST_MIGRATIONS

await applyD1Migrations(env.DB, migrations)

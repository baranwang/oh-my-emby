import { createFileRoute } from "@tanstack/react-router"

import { m } from "@/paraglide/messages.js"

const Overview = () => (
  <div className="max-w-3xl space-y-2">
    <h1 className="font-heading text-2xl font-medium">{m.overview()}</h1>
    <p className="max-w-prose text-sm leading-6 text-muted-foreground">
      {m.overview_description()}
    </p>
  </div>
)

export const Route = createFileRoute("/_authenticated/")({ component: Overview })

import { createFileRoute, redirect } from "@tanstack/react-router"

import { bootstrapQueryOptions, sessionQueryOptions } from "@/modules/auth/services/auth-service"
import { SetupPage } from "@/modules/setup/setup-page"

export const Route = createFileRoute("/setup")({
  beforeLoad: async ({ context }) => {
    const bootstrap = await context.queryClient.ensureQueryData(bootstrapQueryOptions)
    if (!bootstrap.initialized) return

    const session = await context.queryClient.ensureQueryData(sessionQueryOptions)
    if (!session.authenticated) throw redirect({ to: "/login" })
  },
  component: SetupPage
})

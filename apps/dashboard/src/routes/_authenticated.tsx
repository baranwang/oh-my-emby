import { createFileRoute, Outlet, redirect } from "@tanstack/react-router"

import { AppShell } from "@/components/app-shell/app-shell"
import { bootstrapQueryOptions, sessionQueryOptions } from "@/modules/auth/services/auth-service"

export const Route = createFileRoute("/_authenticated")({
  beforeLoad: async ({ context }) => {
    const bootstrap = await context.queryClient.ensureQueryData(bootstrapQueryOptions)
    if (!bootstrap.initialized) throw redirect({ to: "/setup" })

    const session = await context.queryClient.ensureQueryData(sessionQueryOptions)
    if (!session.authenticated) throw redirect({ to: "/login" })
  },
  component: () => <AppShell><Outlet /></AppShell>
})

import { createFileRoute, redirect } from "@tanstack/react-router"

import { LoginPage } from "@/modules/auth/login-page"
import { bootstrapQueryOptions, sessionQueryOptions } from "@/modules/auth/services/auth-service"

export const Route = createFileRoute("/login")({
  beforeLoad: async ({ context }) => {
    const bootstrap = await context.queryClient.ensureQueryData(bootstrapQueryOptions)
    if (!bootstrap.initialized) throw redirect({ to: "/setup" })

    const session = await context.queryClient.ensureQueryData(sessionQueryOptions)
    if (session.authenticated) throw redirect({ to: "/" })
  },
  component: LoginPage
})

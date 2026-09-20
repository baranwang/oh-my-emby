import { useEffect } from "react"
import type { QueryClient } from "@tanstack/react-query"
import { createRootRouteWithContext, Outlet } from "@tanstack/react-router"

import { Button } from "@/components/ui/button"
import { m } from "@/paraglide/messages.js"
import { getLocale } from "@/paraglide/runtime.js"

const Root = () => {
  useEffect(() => {
    document.documentElement.lang = getLocale()
    document.title = m.app_name()
  })

  return (
    <>
      <a
        className="fixed top-2 left-2 z-50 -translate-y-16 rounded-md bg-background px-3 py-2 text-sm font-medium shadow-md focus:translate-y-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        href="#main-content"
      >
        {m.skip_to_content()}
      </a>
      <Outlet />
    </>
  )
}

const ApiUnavailable = () => (
  <main id="main-content" className="grid min-h-svh place-items-center px-6 py-16">
    <div className="w-full max-w-lg space-y-4">
      <h1 className="font-heading text-2xl font-medium">{m.api_unavailable_title()}</h1>
      <p className="max-w-prose text-sm leading-6 text-muted-foreground">
        {m.api_unavailable_description()}
      </p>
      <Button onClick={() => globalThis.location.reload()}>{m.retry()}</Button>
    </div>
  </main>
)

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: Root,
  errorComponent: ApiUnavailable
})

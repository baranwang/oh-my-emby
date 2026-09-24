import type { QueryClient } from "@tanstack/react-query"
import {
  createBrowserHistory,
  createRouter,
  type RouterHistory
} from "@tanstack/react-router"

import { queryClient as singletonQueryClient } from "@/lib/query-client"
import { routeTree } from "@/routeTree.gen"

type RouterOptions = {
  readonly history?: RouterHistory
  readonly queryClient?: QueryClient
}

export const createDashboardRouter = (options: RouterOptions = {}) => createRouter({
  routeTree,
  basepath: "/dashboard",
  defaultPreload: "intent",
  context: { queryClient: options.queryClient ?? singletonQueryClient },
  history: options.history ?? createBrowserHistory()
})

export const router = createDashboardRouter()

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}

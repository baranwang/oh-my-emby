import { createFileRoute } from "@tanstack/react-router"

import { SystemPage } from "@/modules/system/system-page"
import {
  outboxFailuresQueryOptions,
  systemQueryOptions
} from "@/modules/system/services/system-service"

export const Route = createFileRoute("/_authenticated/system")({
  loader: ({ context }) => Promise.all([
    context.queryClient.prefetchQuery(systemQueryOptions(context.queryClient)),
    context.queryClient.prefetchQuery(outboxFailuresQueryOptions(context.queryClient))
  ]),
  component: SystemPage
})

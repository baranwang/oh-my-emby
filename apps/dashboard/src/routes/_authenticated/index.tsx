import { createFileRoute } from "@tanstack/react-router"

import { librariesQueryOptions } from "@/modules/libraries/services/library-service"
import { OverviewPage } from "@/modules/overview/overview-page"
import { serversQueryOptions } from "@/modules/servers/services/server-service"
import { outboxFailuresQueryOptions, systemQueryOptions } from "@/modules/system/services/system-service"

export const Route = createFileRoute("/_authenticated/")({
  loader: ({ context }) => Promise.all([
    context.queryClient.prefetchQuery(serversQueryOptions(context.queryClient)),
    context.queryClient.prefetchQuery(librariesQueryOptions(context.queryClient)),
    context.queryClient.prefetchQuery(systemQueryOptions(context.queryClient)),
    context.queryClient.prefetchQuery(outboxFailuresQueryOptions(context.queryClient))
  ]),
  component: OverviewPage
})

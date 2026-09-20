import { createFileRoute } from "@tanstack/react-router"

import { ServersPage } from "@/modules/servers/servers-page"
import { serversQueryOptions } from "@/modules/servers/services/server-service"

export const Route = createFileRoute("/_authenticated/servers/")({
  validateSearch: (search: Record<string, unknown>) => ({
    new: search.new === true || search.new === "true"
  }),
  loader: ({ context }) => context.queryClient.prefetchQuery(serversQueryOptions(context.queryClient)),
  component: () => {
    const search = Route.useSearch()
    const navigate = Route.useNavigate()
    return (
      <ServersPage
        creating={search.new}
        onCreatingChange={(creating) => void navigate({ search: { new: creating }, replace: true })}
      />
    )
  }
})

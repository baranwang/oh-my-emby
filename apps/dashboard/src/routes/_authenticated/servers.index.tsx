import { createFileRoute } from "@tanstack/react-router"

import { ServersPage } from "@/modules/servers/servers-page"
import { serversQueryOptions } from "@/modules/servers/services/server-service"

export const Route = createFileRoute("/_authenticated/servers/")({
  validateSearch: (search: Record<string, unknown>) => ({
    new: search.new === true || search.new === "true" ? true : undefined
  }),
  loader: ({ context }) => context.queryClient.prefetchQuery(serversQueryOptions(context.queryClient)),
  component: () => {
    const search = Route.useSearch()
    const navigate = Route.useNavigate()
    return (
      <ServersPage
        creating={search.new === true}
        onCreate={() => void navigate({ search: { new: true } })}
        onClose={() => void navigate({ to: "/servers", search: { new: undefined } })}
      />
    )
  }
})

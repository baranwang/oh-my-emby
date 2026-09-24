import { createFileRoute } from "@tanstack/react-router"

import { LibrariesPage } from "@/modules/libraries/libraries-page"
import { librariesQueryOptions } from "@/modules/libraries/services/library-service"
import { serversQueryOptions } from "@/modules/servers/services/server-service"

export const Route = createFileRoute("/_authenticated/libraries/")({
  validateSearch: (search: Record<string, unknown>) => ({
    new: search.new === true || search.new === "true" ? true : undefined
  }),
  loader: ({ context }) => Promise.all([
    context.queryClient.prefetchQuery(librariesQueryOptions(context.queryClient)),
    context.queryClient.prefetchQuery(serversQueryOptions(context.queryClient))
  ]),
  component: () => {
    const search = Route.useSearch()
    const navigate = Route.useNavigate()
    return (
      <LibrariesPage
        creating={search.new === true}
        onAddServer={() => void navigate({ to: "/servers", search: { new: true } })}
        onCreate={() => void navigate({ search: { new: true } })}
        onClose={() => void navigate({ to: "/libraries", search: { new: undefined } })}
      />
    )
  }
})

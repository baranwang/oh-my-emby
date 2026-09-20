import { createFileRoute } from "@tanstack/react-router"

import { LibrariesPage } from "@/modules/libraries/libraries-page"
import { librariesQueryOptions } from "@/modules/libraries/services/library-service"
import { serversQueryOptions } from "@/modules/servers/services/server-service"

export const Route = createFileRoute("/_authenticated/libraries/")({
  validateSearch: (search: Record<string, unknown>) => ({
    new: search.new === true || search.new === "true"
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
        creating={search.new}
        onAddServer={() => void navigate({ to: "/servers", search: { new: true } })}
        onCreatingChange={(creating) => void navigate({ search: { new: creating }, replace: true })}
      />
    )
  }
})

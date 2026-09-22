import { VirtualLibraryId } from "@oh-my-emby/contracts"
import { createFileRoute } from "@tanstack/react-router"
import { Schema } from "effect"

import { LibrariesPage } from "@/modules/libraries/libraries-page"
import { librariesQueryOptions, libraryQueryOptions } from "@/modules/libraries/services/library-service"
import { serversQueryOptions } from "@/modules/servers/services/server-service"

const decodeLibraryId = Schema.decodeUnknownSync(VirtualLibraryId)

export const Route = createFileRoute("/_authenticated/libraries/$id")({
  params: {
    parse: ({ id }) => ({ id: decodeLibraryId(id) }),
    stringify: ({ id }) => ({ id })
  },
  loader: ({ context, params }) => Promise.all([
    context.queryClient.prefetchQuery(librariesQueryOptions(context.queryClient)),
    context.queryClient.prefetchQuery(libraryQueryOptions(params.id, context.queryClient)),
    context.queryClient.prefetchQuery(serversQueryOptions(context.queryClient))
  ]),
  component: () => {
    const navigate = Route.useNavigate()
    return (
      <LibrariesPage
        selectedId={Route.useParams().id}
        onAddServer={() => void navigate({ to: "/servers", search: { new: true } })}
        onCreate={() => void navigate({ to: "/libraries", search: { new: true } })}
        onClose={() => void navigate({ to: "/libraries", search: { new: undefined } })}
      />
    )
  }
})

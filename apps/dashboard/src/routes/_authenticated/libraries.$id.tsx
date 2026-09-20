import { VirtualLibraryId } from "@oh-my-emby/contracts"
import { createFileRoute } from "@tanstack/react-router"
import { Schema } from "effect"

import { LibraryDetailPage } from "@/modules/libraries/components/library-detail"
import { libraryQueryOptions } from "@/modules/libraries/services/library-service"
import { serversQueryOptions } from "@/modules/servers/services/server-service"

const decodeLibraryId = Schema.decodeUnknownSync(VirtualLibraryId)

export const Route = createFileRoute("/_authenticated/libraries/$id")({
  params: {
    parse: ({ id }) => ({ id: decodeLibraryId(id) }),
    stringify: ({ id }) => ({ id })
  },
  loader: ({ context, params }) => Promise.all([
    context.queryClient.prefetchQuery(libraryQueryOptions(params.id, context.queryClient)),
    context.queryClient.prefetchQuery(serversQueryOptions(context.queryClient))
  ]),
  component: () => <LibraryDetailPage id={Route.useParams().id} />
})

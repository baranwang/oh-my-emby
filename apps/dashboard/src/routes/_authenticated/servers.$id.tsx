import { ServerId } from "@oh-my-emby/contracts"
import { createFileRoute } from "@tanstack/react-router"
import { Schema } from "effect"

import { ServerDetailPage } from "@/modules/servers/components/server-detail"
import { serverQueryOptions } from "@/modules/servers/services/server-service"

const decodeServerId = Schema.decodeUnknownSync(ServerId)

export const Route = createFileRoute("/_authenticated/servers/$id")({
  params: {
    parse: ({ id }) => ({ id: decodeServerId(id) }),
    stringify: ({ id }) => ({ id })
  },
  loader: ({ context, params }) => context.queryClient.prefetchQuery(
    serverQueryOptions(params.id, context.queryClient)
  ),
  component: () => <ServerDetailPage id={Route.useParams().id} />
})

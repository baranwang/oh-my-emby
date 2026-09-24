import { ServerId } from "@oh-my-emby/contracts"
import { createFileRoute } from "@tanstack/react-router"
import { Schema } from "effect"

import { ServersPage } from "@/modules/servers/servers-page"
import { serverQueryOptions, serversQueryOptions } from "@/modules/servers/services/server-service"

const decodeServerId = Schema.decodeUnknownSync(ServerId)

export const Route = createFileRoute("/_authenticated/servers/$id")({
  params: {
    parse: ({ id }) => ({ id: decodeServerId(id) }),
    stringify: ({ id }) => ({ id })
  },
  loader: ({ context, params }) => Promise.all([
    context.queryClient.prefetchQuery(serversQueryOptions(context.queryClient)),
    context.queryClient.prefetchQuery(serverQueryOptions(params.id, context.queryClient))
  ]),
  component: () => {
    const navigate = Route.useNavigate()
    return (
      <ServersPage
        selectedId={Route.useParams().id}
        onCreate={() => void navigate({ to: "/servers", search: { new: true } })}
        onClose={() => void navigate({ to: "/servers", search: { new: undefined } })}
      />
    )
  }
})

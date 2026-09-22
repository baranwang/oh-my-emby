import type { ServerView } from "@oh-my-emby/contracts"

import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle
} from "@/components/ui/drawer"
import { ScrollArea } from "@/components/ui/scroll-area"
import { ServerDetailPage } from "@/modules/servers/components/server-detail"
import { ServerForm } from "@/modules/servers/components/server-form"
import { ServerList } from "@/modules/servers/components/server-list"
import { useCreateServer, useServers } from "@/modules/servers/hooks/use-servers"
import { m } from "@/paraglide/messages.js"

type ServersPageProps = {
  readonly creating?: boolean
  readonly selectedId?: ServerView["id"]
  readonly onCreate: () => void
  readonly onClose: () => void
}

export const ServersPage = ({ creating = false, selectedId, onCreate, onClose }: ServersPageProps) => {
  const servers = useServers()
  const create = useCreateServer()
  const open = creating || selectedId !== undefined

  return (
    <div className="max-w-7xl space-y-8">
      <header className="space-y-2">
        <h1 className="font-heading text-2xl font-medium">{m.servers()}</h1>
        <p className="max-w-prose text-sm leading-6 text-muted-foreground">{m.servers_description()}</p>
      </header>
      <ServerList
        state={servers.isPending ? "pending" : servers.isError ? "error" : "success"}
        servers={servers.data ?? []}
        onRetry={() => void servers.refetch()}
        onCreate={onCreate}
      />
      <Drawer open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose() }} swipeDirection="right">
        <DrawerContent className="[--drawer-inset:--spacing(2)] data-[swipe-axis=x]:sm:[--drawer-content-width:38rem]">
          <DrawerHeader>
            <DrawerTitle>{creating ? m.server_create_title() : m.server_edit_title()}</DrawerTitle>
            <DrawerDescription>{m.servers_description()}</DrawerDescription>
          </DrawerHeader>
          <ScrollArea className="min-h-0 flex-1">
            <div className="p-4">
              {creating ? (
                <ServerForm
                  onCancel={onClose}
                  onSave={async (input) => {
                    await create.mutateAsync(input)
                    onClose()
                  }}
                />
              ) : selectedId ? (
                <ServerDetailPage id={selectedId} onClose={onClose} />
              ) : null}
            </div>
          </ScrollArea>
        </DrawerContent>
      </Drawer>
    </div>
  )
}

import type { ServerView } from "@oh-my-emby/contracts";
import { useState } from "react";

import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ServerDetailPage } from "@/modules/servers/components/server-detail";
import { ServerForm } from "@/modules/servers/components/server-form";
import { ServerList } from "@/modules/servers/components/server-list";
import { useSaveServer, useServers } from "@/modules/servers/hooks/use-servers";
import { ServerDiscoveryError } from "@/modules/servers/services/server-service";
import { m } from "@/paraglide/messages.js";

type ServersPageProps = {
  readonly creating?: boolean;
  readonly selectedId?: ServerView["id"];
  readonly onCreate: () => void;
  readonly onClose: () => void;
};

const CreateServerForm = ({
  onClose,
  footerContainer,
}: {
  readonly onClose: () => void;
  readonly footerContainer: HTMLElement | null;
}) => {
  const [savedServer, setSavedServer] = useState<ServerView>();
  const save = useSaveServer(savedServer?.id);
  return (
    <ServerForm
      {...(savedServer ? { server: savedServer } : {})}
      footerContainer={footerContainer}
      onCancel={onClose}
      onSave={async (input) => {
        try {
          await save.mutateAsync(input);
          onClose();
        } catch (error) {
          if (error instanceof ServerDiscoveryError) setSavedServer(error.server);
          throw error;
        }
      }}
    />
  );
};

export const ServersPage = ({
  creating = false,
  selectedId,
  onCreate,
  onClose,
}: ServersPageProps) => {
  const servers = useServers();
  const [footerContainer, setFooterContainer] = useState<HTMLDivElement | null>(null);
  const open = creating || selectedId !== undefined;

  return (
    <div className="max-w-7xl space-y-8">
      <header className="space-y-2">
        <h1 className="font-heading text-2xl font-medium">{m.servers()}</h1>
        <p className="text-muted-foreground max-w-prose text-sm leading-6">
          {m.servers_description()}
        </p>
      </header>
      <ServerList
        state={servers.isPending ? "pending" : servers.isError ? "error" : "success"}
        servers={servers.data ?? []}
        onRetry={() => void servers.refetch()}
        onCreate={onCreate}
      />
      <Drawer
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) onClose();
        }}
        swipeDirection="right"
      >
        <DrawerContent className="data-[swipe-axis=x]:sm:[--drawer-content-width:38rem]">
          <DrawerHeader>
            <DrawerTitle>{creating ? m.server_create_title() : m.server_edit_title()}</DrawerTitle>
            <DrawerDescription>{m.servers_description()}</DrawerDescription>
          </DrawerHeader>
          <ScrollArea className="min-h-0 flex-1">
            <div className="p-4">
              {creating ? (
                <CreateServerForm footerContainer={footerContainer} onClose={onClose} />
              ) : selectedId ? (
                <ServerDetailPage
                  id={selectedId}
                  onClose={onClose}
                  footerContainer={footerContainer}
                />
              ) : null}
            </div>
          </ScrollArea>
          <DrawerFooter ref={setFooterContainer} />
        </DrawerContent>
      </Drawer>
    </div>
  );
};

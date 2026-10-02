import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { LibraryDetailPage } from "@/modules/libraries/components/library-detail";
import { LibraryForm } from "@/modules/libraries/components/library-form";
import { LibraryList } from "@/modules/libraries/components/library-list";
import {
  useCreateLibrary,
  useLibraries,
  useSourceLibraryGroups,
} from "@/modules/libraries/hooks/use-libraries";
import { useServers } from "@/modules/servers/hooks/use-servers";
import { m } from "@/paraglide/messages.js";

type LibrariesPageProps = {
  readonly creating?: boolean;
  readonly selectedId?: Parameters<typeof LibraryDetailPage>[0]["id"];
  readonly onAddServer: () => void;
  readonly onCreate: () => void;
  readonly onClose: () => void;
};

export const LibrariesPage = ({
  creating = false,
  selectedId,
  onAddServer,
  onCreate,
  onClose,
}: LibrariesPageProps) => {
  const libraries = useLibraries();
  const servers = useServers();
  const groups = useSourceLibraryGroups(servers.data ?? [], creating);
  const create = useCreateLibrary();
  const open = creating || selectedId !== undefined;
  let listState: "pending" | "error" | "success" = "success";
  if (libraries.isPending) listState = "pending";
  else if (libraries.isError) listState = "error";

  const renderDrawerContent = () => {
    if (!creating) {
      return selectedId ? <LibraryDetailPage id={selectedId} onClose={onClose} /> : null;
    }
    if (servers.isPending) {
      return <Skeleton aria-label={m.servers_loading()} className="h-24 w-full" />;
    }
    if (servers.isError || !servers.data) {
      return (
        <div role="alert" className="space-y-2">
          <p className="text-destructive text-sm">{m.servers_load_failed()}</p>
          <Button type="button" variant="outline" onClick={() => void servers.refetch()}>
            {m.retry()}
          </Button>
        </div>
      );
    }
    if (servers.data.length === 0) {
      return (
        <div className="space-y-3">
          <p className="text-muted-foreground text-sm">{m.servers_empty()}</p>
          <Button type="button" onClick={onAddServer}>
            {m.add_server()}
          </Button>
        </div>
      );
    }
    return (
      <LibraryForm
        groups={groups}
        onCancel={onClose}
        onSave={async (input) => {
          await create.mutateAsync(input);
          onClose();
        }}
      />
    );
  };

  return (
    <div className="max-w-5xl space-y-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <h1 className="font-heading text-2xl font-medium">{m.libraries()}</h1>
          <p className="text-muted-foreground max-w-prose text-sm leading-6">
            {m.libraries_description()}
          </p>
        </div>
        {!creating && libraries.data?.length !== 0 && (
          <Button onClick={onCreate}>{m.add_library()}</Button>
        )}
      </header>
      <LibraryList
        state={listState}
        libraries={libraries.data ?? []}
        onRetry={() => void libraries.refetch()}
        onCreate={onCreate}
      />
      <Drawer
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) onClose();
        }}
        swipeDirection="right"
      >
        <DrawerContent className="[--drawer-inset:--spacing(2)] data-[swipe-axis=x]:sm:[--drawer-content-width:42rem]">
          <DrawerHeader>
            <DrawerTitle>
              {creating ? m.library_create_title() : m.library_edit_title()}
            </DrawerTitle>
            <DrawerDescription>{m.libraries_description()}</DrawerDescription>
          </DrawerHeader>
          <ScrollArea className="min-h-0 flex-1">
            <div className="p-4">{renderDrawerContent()}</div>
          </ScrollArea>
        </DrawerContent>
      </Drawer>
    </div>
  );
};

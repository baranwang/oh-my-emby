import { LibraryCover } from "./library-cover";
import type { LibraryCoverPhase } from "../covers/coordinator";
import type { VirtualLibraryView } from "@oh-my-emby/contracts";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { LibraryForm } from "@/modules/libraries/components/library-form";
import {
  useDeleteLibrary,
  useLibrary,
  useSourceLibraryGroups,
  useUpdateLibrary,
} from "@/modules/libraries/hooks/use-libraries";
import { useServers } from "@/modules/servers/hooks/use-servers";
import { m } from "@/paraglide/messages.js";

type LibraryId = VirtualLibraryView["id"];

const isNotFound = (error: unknown) =>
  typeof error === "object" && error !== null && "_tag" in error && error._tag === "NotFound";

export const LibraryDetailPage = ({
  id,
  onClose,
  coverState = "idle",
  onGenerateCover,
}: {
  readonly id: LibraryId;
  readonly onClose: () => void;
  readonly coverState?: LibraryCoverPhase;
  readonly onGenerateCover?: () => void;
}) => {
  const library = useLibrary(id);
  const servers = useServers();
  const groups = useSourceLibraryGroups(servers.data ?? []);
  const update = useUpdateLibrary(id);
  const remove = useDeleteLibrary(id);

  if (library.isPending || servers.isPending) {
    return (
      <div aria-label={m.loading()} className="max-w-3xl space-y-4">
        <Skeleton className="h-10 w-52" />
        <Skeleton className="h-96" />
      </div>
    );
  }
  if (library.isError || servers.isError || !library.data) {
    if (isNotFound(library.error)) {
      return (
        <div role="alert" className="border-destructive/40 space-y-4 rounded-lg border p-4">
          <div>
            <h2 className="text-destructive font-medium">{m.library_not_found_title()}</h2>
            <p className="text-muted-foreground mt-1 text-sm">
              {m.library_not_found_description()}
            </p>
          </div>
          <Button variant="outline" onClick={onClose}>
            {m.library_back_to_list()}
          </Button>
        </div>
      );
    }
    return (
      <div role="alert" className="border-destructive/40 max-w-3xl space-y-3 rounded-lg border p-4">
        <p className="text-destructive text-sm">{m.libraries_load_failed()}</p>
        <Button
          variant="outline"
          onClick={() => {
            void library.refetch();
            void servers.refetch();
          }}
        >
          {m.retry()}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <section aria-label={m.library_cover_title()}>
        <LibraryCover
          library={library.data}
          state={coverState}
          {...(onGenerateCover ? { onGenerate: onGenerateCover } : {})}
        />
      </section>
      <LibraryForm
        library={library.data}
        groups={groups}
        onCancel={onClose}
        onSave={async (input) => {
          await update.mutateAsync(input);
          onClose();
        }}
      />
      <section className="border-t pt-6">
        <Button
          variant="destructive"
          disabled={remove.isPending}
          onClick={async () => {
            if (!window.confirm(m.library_delete_confirm())) return;
            try {
              await remove.mutateAsync();
              onClose();
            } catch {
              // Mutation state renders the localized failure below.
            }
          }}
        >
          {remove.isPending ? m.deleting() : m.delete()}
        </Button>
        {remove.isError && (
          <p role="alert" className="text-destructive mt-2 text-sm">
            {m.library_delete_failed()}
          </p>
        )}
      </section>
    </div>
  );
};

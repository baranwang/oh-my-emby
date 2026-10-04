import { LibraryCover } from "./library-cover";
import type { LibraryCoverPhase } from "../covers/coordinator";
import type { VirtualLibraryView } from "@oh-my-emby/contracts";
import { Link } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { m } from "@/paraglide/messages.js";

type LibraryListProps = {
  readonly state: "pending" | "error" | "success";
  readonly libraries: ReadonlyArray<VirtualLibraryView>;
  readonly coverPhases?: Readonly<Record<string, LibraryCoverPhase>>;
  readonly onRetry: () => void;
  readonly onCreate: () => void;
};

export const LibraryList = ({
  state,
  libraries,
  onRetry,
  onCreate,
  coverPhases,
}: LibraryListProps) => {
  if (state === "pending") {
    return (
      <div aria-label={m.libraries_loading()} className="space-y-3">
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
    );
  }
  if (state === "error") {
    return (
      <div role="alert" className="border-destructive/40 space-y-3 rounded-lg border p-4">
        <p className="text-destructive text-sm">{m.libraries_load_failed()}</p>
        <Button variant="outline" onClick={onRetry}>
          {m.retry()}
        </Button>
      </div>
    );
  }
  if (libraries.length === 0) {
    return (
      <div className="space-y-3 rounded-lg border border-dashed p-6">
        <p className="text-muted-foreground text-sm">{m.libraries_empty()}</p>
        <Button onClick={onCreate}>{m.add_library()}</Button>
      </div>
    );
  }
  return (
    <ul className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
      {libraries.map((library) => (
        <li key={library.id} className="bg-card text-card-foreground rounded-lg border p-4">
          <Link
            className="focus-visible:ring-ring block rounded-md outline-none focus-visible:ring-2"
            to="/libraries/$id"
            params={{ id: library.id }}
          >
            <div className="mb-4">
              <LibraryCover library={library} state={coverPhases?.[library.id] ?? "idle"} />
            </div>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="font-medium">{library.name}</h2>
                <p className="text-muted-foreground text-sm">
                  {library.mediaType === "movies" ? m.media_movies() : m.media_series()}
                </p>
              </div>
              <span className="bg-muted rounded-md px-2 py-1 text-xs">
                {library.enabled ? m.enabled() : m.disabled()}
              </span>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
};

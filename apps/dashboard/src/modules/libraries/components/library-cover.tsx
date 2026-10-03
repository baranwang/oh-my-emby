import type { VirtualLibraryView } from "@oh-my-emby/contracts";
import { ImageIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages.js";
import type { LibraryCoverPhase } from "../covers/coordinator";
export function LibraryCover({
  library,
  state = "idle",
  onGenerate,
}: {
  readonly library: VirtualLibraryView;
  readonly state?: LibraryCoverPhase;
  readonly onGenerate?: () => void;
}) {
  const busy = state !== "idle" && state !== "error";
  return (
    <div className="space-y-3">
      <div className="bg-muted relative aspect-video overflow-hidden rounded-md">
        {library.cover ? (
          <img
            className="size-full object-cover"
            src={`/api/dashboard/libraries/${encodeURIComponent(library.id)}/cover?tag=${library.cover.revision}`}
            alt={library.name}
          />
        ) : (
          <div className="text-muted-foreground flex size-full items-center justify-center">
            <ImageIcon className="size-10" aria-label={m.library_cover_missing()} />
          </div>
        )}
        {busy && (
          <div
            role="status"
            className="absolute inset-x-0 bottom-0 bg-black/60 px-3 py-2 text-xs text-white"
          >
            {m.library_cover_generating()}
          </div>
        )}
      </div>
      {state === "error" && (
        <p role="alert" className="text-destructive text-sm">
          {m.library_cover_failed()}
        </p>
      )}
      {onGenerate && (
        <Button
          type="button"
          variant="outline"
          disabled={busy || !library.enabled}
          onClick={onGenerate}
        >
          {busy ? m.library_cover_generating() : m.library_cover_regenerate()}
        </Button>
      )}
    </div>
  );
}

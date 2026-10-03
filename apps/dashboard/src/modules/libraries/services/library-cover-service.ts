import { LibraryCoverSummary } from "@oh-my-emby/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import { apiClient } from "@/lib/api-client";
import { queryKeys } from "@/lib/query-keys";
import { handleUnauthorized, runProtected } from "@/modules/auth/services/auth-service";
import { libraryQueryOptions } from "./library-service";
import type { LibraryCoverPhase } from "../covers/coordinator";
export async function generateLibraryCover(
  id: string,
  queryClient: QueryClient,
  signal?: AbortSignal,
  onPhase?: (phase: LibraryCoverPhase) => void,
): Promise<LibraryCoverSummary> {
  signal?.throwIfAborted();
  onPhase?.("preparing");
  const preparation = await runProtected(
    apiClient.libraries.prepareLibraryCover({ params: { id: id as never } }),
    queryClient,
  );
  signal?.throwIfAborted();
  const [{ prepareLibraryCoverAssets }, { renderLibraryCover }] = await Promise.all([
    import("../covers/assets"),
    import("../covers/render"),
  ]);
  const assets = await prepareLibraryCoverAssets(preparation, signal);
  onPhase?.("rendering");
  const image = await renderLibraryCover(
    { ...assets, title: preparation.title, subtitle: preparation.subtitle },
    signal,
  );
  signal?.throwIfAborted();
  onPhase?.("uploading");
  const response = await fetch(`/api/dashboard/libraries/${encodeURIComponent(id)}/cover`, {
    method: "PUT",
    credentials: "same-origin",
    headers: { "content-type": "image/jpeg", "x-cover-token": preparation.token },
    body: image,
    ...(signal ? { signal } : {}),
  });
  if (response.status === 401) {
    await handleUnauthorized(queryClient);
    throw new Error("Session expired");
  }
  if (response.status === 409) {
    await queryClient.invalidateQueries({ queryKey: queryKeys.libraries });
    const current = await queryClient.fetchQuery(libraryQueryOptions(id as never, queryClient));
    if (current.cover) return current.cover;
    throw new Error("Cover generation became obsolete");
  }
  if (!response.ok) throw new Error("Cover upload failed");
  const cover = Schema.decodeUnknownSync(LibraryCoverSummary)(await response.json());
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.libraries }),
    queryClient.invalidateQueries({ queryKey: queryKeys.library(id as never) }),
  ]);
  return cover;
}

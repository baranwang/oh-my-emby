import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { VirtualLibraryInput, VirtualLibraryView } from "@oh-my-emby/contracts";
import {
  LibraryForm,
  type SourceLibraryGroup,
} from "../src/modules/libraries/components/library-form";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
it("removes an unavailable binding when the user excludes it before saving another source", async () => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  let saved: VirtualLibraryInput | undefined;
  const library = {
    id: "library-1",
    name: "Series",
    mediaType: "series",
    enabled: true,
    sources: [
      { serverId: "old", sourceLibraryId: "old-series", sourceLibraryName: "Old", enabled: true },
      { serverId: "new", sourceLibraryId: "new-series", sourceLibraryName: "New", enabled: true },
    ],
  } as VirtualLibraryView;
  const groups = [
    {
      server: {
        id: "old",
        name: "Old server",
        enabled: false,
        health: "unknown",
        verifiedCatalogId: null,
      },
      state: "unavailable",
      sources: [],
    },
    {
      server: {
        id: "new",
        name: "New server",
        enabled: true,
        health: "healthy",
        verifiedCatalogId: "catalog",
      },
      state: "success",
      sources: [{ id: "new-series", serverId: "new", name: "New", mediaType: "series" }],
    },
  ] as SourceLibraryGroup[];
  try {
    await act(async () =>
      root.render(
        <LibraryForm
          library={library}
          groups={groups}
          onSave={async (input) => {
            saved = input;
          }}
        />,
      ),
    );
    const oldSwitch = container.querySelector(
      'section[aria-labelledby="source-server-old"] [role="switch"]',
    ) as HTMLButtonElement;
    expect(oldSwitch).not.toBeNull();
    await act(async () => oldSwitch.click());
    await act(async () =>
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    await vi.waitFor(() => expect(saved).toBeDefined());
    expect(saved!.sources).toEqual([
      { serverId: "new", sourceLibraryId: "new-series", enabled: true },
    ]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

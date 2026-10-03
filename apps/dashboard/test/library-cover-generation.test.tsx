import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect } from "vitest";
import { LibraryCoverCoordinator } from "../src/modules/libraries/covers/coordinator.js";
import { LibraryCover } from "../src/modules/libraries/components/library-cover.js";
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
describe("cover generation coordination", () => {
  it("serializes libraries and attempts automatic failures once, allowing manual retry", async () => {
    let resolve!: () => void;
    const calls: string[] = [];
    const coordinator = new LibraryCoverCoordinator(async (id) => {
      calls.push(id);
      if (id === "a")
        await new Promise<void>((r) => {
          resolve = r;
        });
      if (id === "b" && calls.filter((x) => x === "b").length === 1) throw Error("failed");
    });
    coordinator.enqueue("a", "automatic");
    coordinator.enqueue("a", "automatic");
    coordinator.enqueue("b", "automatic");
    expect(calls).toEqual(["a"]);
    resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual(["a", "b"]);
    coordinator.enqueue("b", "automatic");
    expect(calls).toEqual(["a", "b"]);
    coordinator.enqueue("b", "manual");
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual(["a", "b", "b"]);
  });
  it("cancels outstanding work and clears queued libraries", async () => {
    let aborted = false;
    const calls: string[] = [];
    const c = new LibraryCoverCoordinator(async (id, signal) => {
      calls.push(id);
      await new Promise<void>((_, reject) =>
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(signal.reason);
        }),
      );
    });
    c.enqueue("a", "automatic");
    c.enqueue("b", "automatic");
    c.cancel();
    await new Promise((r) => setTimeout(r, 0));
    expect(aborted).toBe(true);
    expect(calls).toEqual(["a"]);
  });
  it("retains old image while regenerating and exposes refresh action", async () => {
    const host = document.createElement("div"),
      root = createRoot(host);
    const library = {
      id: "lib",
      name: "Movies",
      mediaType: "movies",
      enabled: true,
      sources: [],
      cover: { revision: "old", width: 1920, height: 1080, stale: true },
    } as any;
    let clicked = false;
    await act(async () =>
      root.render(
        <StrictMode>
          <LibraryCover
            library={library}
            state="rendering"
            onGenerate={() => {
              clicked = true;
            }}
          />
        </StrictMode>,
      ),
    );
    expect(host.querySelector("img")?.getAttribute("src")).toContain("old");
    expect(host.querySelector("button")?.disabled).toBe(true);
    await act(async () =>
      root.render(
        <LibraryCover
          library={library}
          state="error"
          onGenerate={() => {
            clicked = true;
          }}
        />,
      ),
    );
    await act(async () => host.querySelector("button")!.click());
    expect(clicked).toBe(true);
    await act(async () => root.unmount());
  });
});

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ThemeProvider } from "../src/components/theme-provider.js";
import { Preferences } from "../src/modules/system/components/preferences.js";
const mocks = vi.hoisted(() => ({ save: vi.fn(), locale: vi.fn(), current: "en" }));
vi.mock("../src/modules/system/hooks/use-system.js", () => ({
  useUpdateMetadataSettings: () => ({ mutateAsync: mocks.save, isPending: false }),
}));
vi.mock("../src/paraglide/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getLocale: () => mocks.current,
  setLocale: mocks.locale,
}));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
  mocks.current = "en";
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
const chooseChinese = async () => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  roots.push(root);
  await act(async () =>
    root.render(
      <ThemeProvider>
        <Preferences />
      </ThemeProvider>,
    ),
  );
  const trigger = document.querySelector('[aria-label="Language"]') as HTMLElement;
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  await vi.waitFor(() => expect(document.querySelectorAll('[role="option"]').length).toBe(2));
  await act(async () =>
    [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((option) => option.textContent?.includes("Chinese"))!
      .click(),
  );
};
it("changes dashboard locale without rewriting TMDB language settings", async () => {
  await chooseChinese();
  expect(mocks.save).not.toHaveBeenCalled();
  expect(mocks.locale).toHaveBeenCalledWith("zh-CN");
});
it("does not synchronize TMDB when opening a Chinese dashboard", async () => {
  mocks.current = "zh-CN";
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  roots.push(root);
  await act(async () =>
    root.render(
      <ThemeProvider>
        <Preferences />
      </ThemeProvider>,
    ),
  );
  expect(mocks.save).not.toHaveBeenCalled();
});

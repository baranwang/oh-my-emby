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
const settings = (language: string | null) => ({
  providers: [
    {
      id: "tmdb" as const,
      enabled: true,
      order: 0,
      language,
      logoLanguage: "metadata" as const,
      posterLanguage: "original" as const,
      systemLanguage: "en-US" as const,
      hasCredential: true,
      status: "ready" as const,
    },
    {
      id: "trakt" as const,
      enabled: false,
      order: 1,
      language: null,
      hasCredential: false,
      status: "unconfigured" as const,
    },
  ] as const,
});
const chooseChinese = async (language: string | null, fails = false) => {
  if (fails) mocks.save.mockRejectedValue(new Error("save failed"));
  else mocks.save.mockResolvedValue(settings(language));
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
        <Preferences settings={settings(language)} />
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
it("updates system-default metadata language before changing the dashboard locale", async () => {
  await chooseChinese(null);
  expect(mocks.save).toHaveBeenCalledWith({
    providers: [
      expect.objectContaining({
        id: "tmdb",
        language: null,
        systemLanguage: "zh-CN",
        logoLanguage: "metadata",
        posterLanguage: "original",
        credential: { _tag: "Preserve" },
      }),
      expect.objectContaining({ id: "trakt", credential: { _tag: "Preserve" } }),
    ],
  });
  expect(mocks.locale).toHaveBeenCalledWith("zh-CN");
});
it("keeps explicit metadata language independent of dashboard locale", async () => {
  await chooseChinese("ja-JP");
  expect(mocks.save).not.toHaveBeenCalled();
  expect(mocks.locale).toHaveBeenCalledWith("zh-CN");
});
it("keeps the dashboard locale when saving the system preference fails", async () => {
  await chooseChinese(null, true);
  expect(mocks.locale).not.toHaveBeenCalled();
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("save");
});

it("synchronizes an existing system-default preference after settings load", async () => {
  mocks.current = "zh-CN";
  mocks.save.mockResolvedValue(settings(null));
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
  expect((document.querySelector("#preference-language") as HTMLButtonElement).disabled).toBe(true);
  expect(mocks.save).not.toHaveBeenCalled();
  await act(async () =>
    root.render(
      <ThemeProvider>
        <Preferences settings={settings(null)} />
      </ThemeProvider>,
    ),
  );
  expect(mocks.save).toHaveBeenCalledWith({
    providers: [
      expect.objectContaining({ systemLanguage: "zh-CN", credential: { _tag: "Preserve" } }),
      expect.any(Object),
    ],
  });
  expect(mocks.locale).not.toHaveBeenCalled();
});

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  MetadataProviderSettingsView,
  MetadataProviderSettingsInput,
} from "@oh-my-emby/contracts";
import { useUpdateMetadataSettings } from "@/modules/system/hooks/use-system";
import { useTheme } from "@/components/theme-provider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { m } from "@/paraglide/messages.js";
import { getLocale, setLocale } from "@/paraglide/runtime.js";

export const Preferences = ({
  settings,
}: {
  readonly settings?: MetadataProviderSettingsView | undefined;
}) => {
  const update = useUpdateMetadataSettings();
  const [saveFailed, setSaveFailed] = useState(false);
  const attemptedSync = useRef<string | null>(null);
  const locale = getLocale();
  const systemLanguage = locale === "zh-CN" ? "zh-CN" : "en-US";
  const tmdb = settings?.providers.find((provider) => provider.id === "tmdb");
  const { mutateAsync } = update;
  const synchronize = useCallback(
    async (value: "en" | "zh-CN") => {
      if (!settings) return false;
      if (tmdb?.language !== null) return true;
      const providers = settings.providers.map<MetadataProviderSettingsInput["providers"][number]>(
        ({ hasCredential: _hasCredential, status: _status, ...provider }) => ({
          ...provider,
          ...(provider.id === "tmdb"
            ? { systemLanguage: value === "zh-CN" ? "zh-CN" : "en-US" }
            : {}),
          credential: { _tag: "Preserve" },
        }),
      );
      try {
        await mutateAsync({ providers: [providers[0]!, providers[1]!] });
        return true;
      } catch {
        setSaveFailed(true);
        return false;
      }
    },
    [settings, tmdb?.language, mutateAsync],
  );
  useEffect(() => {
    if (!settings || tmdb?.language !== null || tmdb.systemLanguage === systemLanguage) return;
    const key = JSON.stringify([settings, systemLanguage]);
    if (attemptedSync.current === key) return;
    attemptedSync.current = key;
    void synchronize(locale);
  }, [settings, tmdb, systemLanguage, locale, synchronize]);
  const changeLanguage = async (value: "en" | "zh-CN") => {
    setSaveFailed(false);
    if (await synchronize(value)) await setLocale(value);
  };
  const { theme, setTheme } = useTheme();

  return (
    <div className="divide-y">
      <div className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0">
        <Label htmlFor="preference-language">{m.language_label()}</Label>
        <Select
          disabled={!settings || update.isPending}
          value={getLocale()}
          onValueChange={(value) => {
            if (value === "en" || value === "zh-CN") void changeLanguage(value);
          }}
        >
          <SelectTrigger id="preference-language" aria-label={m.language_label()}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="en">{m.language_english()}</SelectItem>
            <SelectItem value="zh-CN">{m.language_chinese()}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {saveFailed && (
        <p role="alert" className="text-destructive text-sm">
          {m.metadata_save_failed()}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 py-3">
        <Label htmlFor="preference-theme">{m.theme_label()}</Label>
        <Select
          value={theme}
          onValueChange={(value) => {
            if (value === "system" || value === "light" || value === "dark") setTheme(value);
          }}
        >
          <SelectTrigger id="preference-theme" aria-label={m.theme_label()}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="system">{m.theme_system()}</SelectItem>
            <SelectItem value="light">{m.theme_light()}</SelectItem>
            <SelectItem value="dark">{m.theme_dark()}</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
};

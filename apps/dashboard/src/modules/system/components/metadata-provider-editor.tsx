import { useState } from "react";
import type {
  MetadataProviderSettingsInput,
  MetadataProviderSettingsView,
  SecretPatch,
} from "@oh-my-emby/contracts";
import { useForm } from "@tanstack/react-form";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useUpdateMetadataSettings } from "@/modules/system/hooks/use-system";
import { MetadataLanguageSelect } from "@/modules/system/components/metadata-language-select";
import { m } from "@/paraglide/messages.js";

type Provider = MetadataProviderSettingsView["providers"][number];

type EditorValues = {
  readonly enabled: boolean;
  readonly language: string;
  readonly logoLanguage: string;
  readonly posterLanguage: string;
  readonly credential: SecretPatch;
};

const unchanged = (provider: Provider): MetadataProviderSettingsInput["providers"][number] => ({
  id: provider.id,
  enabled: provider.enabled,
  order: provider.order,
  language: provider.language,
  ...(provider.logoLanguage !== undefined ? { logoLanguage: provider.logoLanguage } : {}),
  ...(provider.posterLanguage !== undefined ? { posterLanguage: provider.posterLanguage } : {}),
  ...(provider.systemLanguage !== undefined ? { systemLanguage: provider.systemLanguage } : {}),
  credential: { _tag: "Preserve" },
});

export const MetadataProviderEditor = ({
  provider,
  settings,
  onClose,
}: {
  readonly provider: Provider;
  readonly settings: MetadataProviderSettingsView;
  readonly onClose: () => void;
}) => {
  const update = useUpdateMetadataSettings();
  const [formError, setFormError] = useState(false);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const form = useForm({
    defaultValues: {
      enabled: provider.enabled,
      language: provider.language ?? "client",
      logoLanguage: (provider.logoLanguage ?? "original") as string,
      posterLanguage: (provider.posterLanguage ?? "original") as string,
      credential: { _tag: "Preserve" } as SecretPatch,
    } satisfies EditorValues,
    onSubmit: async ({ value }) => {
      setFormError(false);
      const edited = {
        id: provider.id,
        enabled: value.enabled,
        order: provider.order,
        language:
          provider.id === "tmdb" && value.language !== "client" ? value.language.trim() : null,
        ...(provider.id === "tmdb"
          ? {
              logoLanguage: value.logoLanguage,
              posterLanguage: value.posterLanguage,
            }
          : {}),
        credential: value.credential,
      } as MetadataProviderSettingsInput["providers"][number];
      const input = settings.providers
        .map((candidate) => (candidate.id === provider.id ? edited : unchanged(candidate)))
        .sort((left, right) => left.order - right.order);
      try {
        await update.mutateAsync({ providers: [input[0]!, input[1]!] });
        onClose();
      } catch {
        setFormError(true);
      }
    },
  });

  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void form.handleSubmit();
      }}
    >
      {formError && (
        <Alert role="alert" variant="destructive">
          <AlertDescription>{m.metadata_save_failed()}</AlertDescription>
        </Alert>
      )}
      <form.Field name="enabled">
        {(field) => (
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="metadata-provider-enabled">{m.metadata_provider_enabled()}</Label>
            <Switch
              id="metadata-provider-enabled"
              checked={field.state.value}
              onCheckedChange={field.handleChange}
            />
          </div>
        )}
      </form.Field>
      <form.Field name="credential">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor={field.name}>
              {provider.id === "tmdb" ? m.metadata_tmdb_token() : m.metadata_trakt_client_id()}
            </Label>
            <Input
              id={field.name}
              name={field.name}
              type="password"
              autoComplete="off"
              value={field.state.value._tag === "Set" ? field.state.value.value : ""}
              placeholder={provider.hasCredential ? m.metadata_credential_preserved() : undefined}
              onChange={(event) => {
                setConfirmingClear(false);
                field.handleChange(
                  event.target.value === ""
                    ? { _tag: "Preserve" }
                    : { _tag: "Set", value: event.target.value },
                );
              }}
            />
            {provider.hasCredential && (
              <div className="space-y-2">
                <div className="flex flex-wrap gap-2">
                  {!confirmingClear && field.state.value._tag !== "Clear" && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setConfirmingClear(true)}
                    >
                      {m.metadata_credential_clear()}
                    </Button>
                  )}
                  {confirmingClear && (
                    <>
                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        onClick={() => {
                          field.handleChange({ _tag: "Clear" });
                          setConfirmingClear(false);
                        }}
                      >
                        {m.metadata_credential_clear_confirm()}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setConfirmingClear(false)}
                      >
                        {m.cancel()}
                      </Button>
                    </>
                  )}
                  {field.state.value._tag === "Clear" && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => field.handleChange({ _tag: "Preserve" })}
                    >
                      {m.metadata_credential_clear_cancel()}
                    </Button>
                  )}
                </div>
                {field.state.value._tag === "Clear" && (
                  <p role="status" className="text-destructive text-sm">
                    {m.metadata_credential_will_clear()}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </form.Field>
      {provider.id === "tmdb" && (
        <>
          <form.Field name="language">
            {(field) => (
              <MetadataLanguageSelect
                id="metadata-language"
                label={m.metadata_language_preference()}
                value={field.state.value}
                onChange={field.handleChange}
              />
            )}
          </form.Field>
          <form.Field name="logoLanguage">
            {(field) => (
              <MetadataLanguageSelect
                id="metadata-logo-language"
                label={m.metadata_logo_language()}
                value={field.state.value}
                artwork
                onChange={field.handleChange}
              />
            )}
          </form.Field>
          <form.Field name="posterLanguage">
            {(field) => (
              <MetadataLanguageSelect
                id="metadata-poster-language"
                label={m.metadata_poster_language()}
                value={field.state.value}
                artwork
                onChange={field.handleChange}
              />
            )}
          </form.Field>
        </>
      )}
      <form.Subscribe selector={(state) => state.isSubmitting}>
        {(isSubmitting) => (
          <div className="flex gap-2">
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? m.saving() : m.save()}
            </Button>
            <Button type="button" variant="ghost" onClick={onClose}>
              {m.cancel()}
            </Button>
          </div>
        )}
      </form.Subscribe>
    </form>
  );
};

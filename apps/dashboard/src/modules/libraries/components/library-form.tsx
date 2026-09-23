import { useMemo, useState } from "react";
import type {
  ServerView,
  SourceLibraryView,
  VirtualLibraryInput,
  VirtualLibraryView,
} from "@oh-my-emby/contracts";
import { VirtualLibraryInput as VirtualLibraryInputSchema } from "@oh-my-emby/contracts";
import { useForm } from "@tanstack/react-form";
import { Schema } from "effect";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { m } from "@/paraglide/messages.js";

type SourceServer = Pick<ServerView, "id" | "name" | "enabled" | "health" | "verifiedCatalogId">;
type SourceBindingValue = {
  readonly serverId: string;
  readonly sourceLibraryId: string;
  readonly enabled: boolean;
};

export type SourceLibraryGroup = {
  readonly server: SourceServer;
  readonly state: "pending" | "error" | "unavailable" | "success";
  readonly sources: ReadonlyArray<SourceLibraryView>;
  readonly retry?: () => unknown;
};

type SourceBindingsProps = {
  readonly groups: ReadonlyArray<SourceLibraryGroup>;
  readonly mediaType: VirtualLibraryInput["mediaType"];
  readonly bindings: ReadonlyArray<SourceBindingValue>;
  readonly onToggle: (serverId: string, sourceLibraryId: string, enabled: boolean) => void;
};

export const SourceBindings = ({ groups, mediaType, bindings, onToggle }: SourceBindingsProps) => (
  <div className="space-y-4">
    {groups.map((group) => {
      const sources = group.sources.filter((source) => source.mediaType === mediaType);
      return (
        <section
          key={group.server.id}
          className="space-y-2 rounded-lg border p-4"
          aria-labelledby={`source-server-${group.server.id}`}
        >
          <h3 id={`source-server-${group.server.id}`} className="font-medium">
            {group.server.name}
          </h3>
          {group.state === "pending" && (
            <Skeleton aria-label={m.source_libraries_loading()} className="h-10 w-full" />
          )}
          {group.state === "error" && (
            <div role="alert" className="space-y-2">
              <p className="text-destructive text-sm">{m.source_libraries_failed()}</p>
              <Button type="button" variant="outline" onClick={() => void group.retry?.()}>
                {m.retry()}
              </Button>
            </div>
          )}
          {group.state === "unavailable" && (
            <p className="text-muted-foreground text-sm">{m.source_libraries_unavailable()}</p>
          )}
          {sources.length === 0 ? (
            group.state === "success" && (
              <p className="text-muted-foreground text-sm">{m.source_libraries_empty()}</p>
            )
          ) : (
            <ul className="space-y-2">
              {sources.map((source) => {
                const binding = bindings.find(
                  (item) => item.serverId === source.serverId && item.sourceLibraryId === source.id,
                );
                const enabled = binding?.enabled ?? false;
                const id = `source-${source.serverId}-${source.id}`;
                return (
                  <li
                    key={`${source.serverId}:${source.id}`}
                    className="flex items-center justify-between gap-4"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <Switch
                        id={id}
                        checked={enabled}
                        onCheckedChange={(checked) => onToggle(source.serverId, source.id, checked)}
                      />
                      <span className="min-w-0 truncate">
                        <Label htmlFor={id}>{source.name}</Label>
                      </span>
                    </div>
                    <span className="text-muted-foreground shrink-0 text-xs">
                      {enabled ? m.source_binding_enabled() : m.source_binding_disabled()}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      );
    })}
  </div>
);

type LibraryFormProps = {
  readonly library?: VirtualLibraryView;
  readonly groups: ReadonlyArray<SourceLibraryGroup>;
  readonly onSave: (input: VirtualLibraryInput) => Promise<void>;
  readonly onCancel?: () => void;
};

const libraryValidator = Schema.toStandardSchemaV1(VirtualLibraryInputSchema);

export const LibraryForm = ({ library, groups, onSave, onCancel }: LibraryFormProps) => {
  const [formError, setFormError] = useState<string | null>(null);
  const defaultValues: typeof VirtualLibraryInputSchema.Encoded = {
    name: library?.name ?? "",
    mediaType: library?.mediaType ?? "movies",
    sources:
      library?.sources.map(({ serverId, sourceLibraryId, enabled }) => ({
        serverId,
        sourceLibraryId,
        enabled,
      })) ?? [],
    enabled: library?.enabled ?? true,
  };
  const form = useForm({
    defaultValues,
    validators: { onSubmit: libraryValidator },
    onSubmit: async ({ value }) => {
      setFormError(null);
      try {
        const input = await Schema.decodeUnknownPromise(VirtualLibraryInputSchema)(value);
        await onSave(input);
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "_tag" in error &&
          error._tag === "ParseError"
        )
          return;
        setFormError(m.library_save_failed());
      }
    },
  });

  const completeGroups = useMemo(() => {
    const remaining = new Map(
      library?.sources.map((source) => [`${source.serverId}\0${source.sourceLibraryId}`, source]) ??
        [],
    );
    const merged = groups.map((group) => {
      const sources = [...group.sources];
      for (const source of library?.sources ?? []) {
        if (source.serverId !== group.server.id) continue;
        const key = `${source.serverId}\0${source.sourceLibraryId}`;
        if (!sources.some((candidate) => candidate.id === source.sourceLibraryId)) {
          sources.push({
            id: source.sourceLibraryId,
            serverId: source.serverId,
            name: source.sourceLibraryName,
            mediaType: library!.mediaType,
          } as SourceLibraryView);
        }
        remaining.delete(key);
      }
      return { ...group, sources };
    });
    for (const source of remaining.values()) {
      merged.push({
        server: {
          id: source.serverId,
          name: source.serverId,
          enabled: false,
          health: "unknown",
          verifiedCatalogId: null,
        } as SourceServer,
        state: "unavailable",
        sources: [
          {
            id: source.sourceLibraryId,
            serverId: source.serverId,
            name: source.sourceLibraryName,
            mediaType: library!.mediaType,
          } as SourceLibraryView,
        ],
      });
    }
    return merged;
  }, [groups, library]);

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
        <Alert variant="destructive" role="alert">
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      )}
      <form.Field name="name">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor={field.name}>{m.library_name()}</Label>
            <Input
              id={field.name}
              name={field.name}
              value={field.state.value}
              aria-invalid={field.state.meta.errors.length > 0}
              aria-describedby={field.state.meta.errors.length ? `${field.name}-error` : undefined}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
            />
            {field.state.meta.errors.length > 0 && (
              <p id={`${field.name}-error`} className="text-destructive text-sm">
                {m.library_name_required()}
              </p>
            )}
          </div>
        )}
      </form.Field>
      <form.Field name="mediaType">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor={field.name}>{m.library_media_type()}</Label>
            <select
              id={field.name}
              name={field.name}
              className="border-input bg-background focus-visible:ring-ring h-8 w-full rounded-lg border px-2.5 text-sm outline-none focus-visible:ring-2"
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(event) => {
                field.handleChange(event.target.value as "movies" | "series");
                form.setFieldValue("sources", []);
              }}
            >
              <option value="movies">{m.media_movies()}</option>
              <option value="series">{m.media_series()}</option>
            </select>
          </div>
        )}
      </form.Field>
      <form.Field
        name="sources"
        validators={{
          onSubmit: ({ value }) =>
            value.some((source) => source.enabled) ? undefined : m.library_sources_required(),
        }}
      >
        {(field) => (
          <fieldset
            className="space-y-3"
            aria-invalid={field.state.meta.errors.length > 0}
            aria-describedby={field.state.meta.errors.length > 0 ? "sources-error" : undefined}
          >
            <legend className="text-sm font-medium">{m.library_sources()}</legend>
            <form.Subscribe selector={(state) => state.values.mediaType}>
              {(mediaType) => (
                <SourceBindings
                  groups={completeGroups}
                  mediaType={mediaType}
                  bindings={field.state.value}
                  onToggle={(serverId, sourceLibraryId, enabled) => {
                    const index = field.state.value.findIndex(
                      (item) =>
                        item.serverId === serverId && item.sourceLibraryId === sourceLibraryId,
                    );
                    field.handleChange(
                      index === -1
                        ? [...field.state.value, { serverId, sourceLibraryId, enabled }]
                        : field.state.value.map((item, itemIndex) =>
                            itemIndex === index ? { ...item, enabled } : item,
                          ),
                    );
                  }}
                />
              )}
            </form.Subscribe>
            {field.state.meta.errors.length > 0 && (
              <p id="sources-error" className="text-destructive text-sm">
                {m.library_sources_required()}
              </p>
            )}
          </fieldset>
        )}
      </form.Field>
      <form.Field name="enabled">
        {(field) => (
          <div className="flex items-center gap-2">
            <Switch
              id={field.name}
              name={field.name}
              checked={field.state.value}
              onBlur={field.handleBlur}
              onCheckedChange={field.handleChange}
            />
            <Label htmlFor={field.name}>{m.library_enabled()}</Label>
          </div>
        )}
      </form.Field>
      <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting]}>
        {([canSubmit, isSubmitting]) => (
          <div className="flex gap-2">
            <Button type="submit" disabled={!canSubmit || isSubmitting}>
              {isSubmitting ? m.saving() : m.save()}
            </Button>
            {onCancel && (
              <Button type="button" variant="ghost" onClick={onCancel}>
                {m.cancel()}
              </Button>
            )}
          </div>
        )}
      </form.Subscribe>
    </form>
  );
};

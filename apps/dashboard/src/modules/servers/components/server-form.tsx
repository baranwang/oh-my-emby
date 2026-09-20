import { useState } from "react"
import type { ConnectionTestView, SecretPatch, ServerInput, ServerView } from "@oh-my-emby/contracts"
import { ServerInput as ServerInputSchema } from "@oh-my-emby/contracts"
import { useForm } from "@tanstack/react-form"
import { Schema } from "effect"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { m } from "@/paraglide/messages.js"

type ServerFormProps = {
  readonly server?: ServerView
  readonly onSave: (input: ServerInput) => Promise<void>
  readonly onTestConnection?: () => Promise<ConnectionTestView>
}

const serverValidator = Schema.toStandardSchemaV1(ServerInputSchema)
const preservePassword: SecretPatch = { _tag: "Preserve" }

export const ServerForm = ({ server, onSave, onTestConnection }: ServerFormProps) => {
  const [formError, setFormError] = useState<string | null>(null)
  const [connectionState, setConnectionState] = useState<"idle" | "pending" | "success" | "error">("idle")
  const [confirmingClear, setConfirmingClear] = useState(false)
  const defaultValues: typeof ServerInputSchema.Encoded = {
    name: server?.name ?? "",
    baseUrl: server?.baseUrl ?? "",
    username: server?.username ?? "",
    password: preservePassword,
    userAgent: server?.userAgent ?? m.server_default_user_agent(),
    enabled: server?.enabled ?? true
  }
  const form = useForm({
    defaultValues,
    validators: { onSubmit: serverValidator },
    onSubmit: async ({ value }) => {
      setFormError(null)
      try {
        const input = await Schema.decodeUnknownPromise(ServerInputSchema)(value)
        await onSave(input)
      } catch (error) {
        if (typeof error === "object" && error !== null && "_tag" in error && error._tag === "ParseError") return
        setFormError(m.server_save_failed())
      }
    }
  })

  const testConnection = async () => {
    if (!onTestConnection) return
    setConnectionState("pending")
    try {
      await onTestConnection()
      setConnectionState("success")
    } catch {
      setConnectionState("error")
    }
  }

  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault()
        event.stopPropagation()
        void form.handleSubmit()
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
            <Label htmlFor={field.name}>{m.server_name()}</Label>
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
              <p id={`${field.name}-error`} className="text-sm text-destructive">{m.server_name_required()}</p>
            )}
          </div>
        )}
      </form.Field>
      <form.Field name="baseUrl">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor={field.name}>{m.server_base_url()}</Label>
            <Input
              id={field.name}
              name={field.name}
              type="url"
              inputMode="url"
              value={field.state.value}
              aria-invalid={field.state.meta.errors.length > 0}
              aria-describedby={field.state.meta.errors.length ? `${field.name}-error` : undefined}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
            />
            {field.state.meta.errors.length > 0 && (
              <p id={`${field.name}-error`} className="text-sm text-destructive">{m.server_base_url_invalid()}</p>
            )}
          </div>
        )}
      </form.Field>
      <form.Field name="username">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor={field.name}>{m.username_label()}</Label>
            <Input
              id={field.name}
              name={field.name}
              autoComplete="username"
              value={field.state.value}
              aria-invalid={field.state.meta.errors.length > 0}
              aria-describedby={field.state.meta.errors.length ? `${field.name}-error` : undefined}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
            />
            {field.state.meta.errors.length > 0 && (
              <p id={`${field.name}-error`} className="text-sm text-destructive">{m.username_required()}</p>
            )}
          </div>
        )}
      </form.Field>
      <form.Field
        name="password"
        validators={{
          onSubmit: ({ value }) => !server && value._tag === "Preserve" ? m.server_password_required() : undefined
        }}
      >
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor={field.name}>{m.server_password()}</Label>
            <Input
              id={field.name}
              name={field.name}
              type="password"
              autoComplete="new-password"
              value={field.state.value._tag === "Set" ? field.state.value.value : ""}
              aria-invalid={field.state.meta.errors.length > 0}
              aria-describedby={field.state.meta.errors.length ? `${field.name}-error` : `${field.name}-hint`}
              onBlur={field.handleBlur}
              onChange={(event) => {
                setConfirmingClear(false)
                field.handleChange(event.target.value
                  ? { _tag: "Set", value: event.target.value }
                  : preservePassword)
              }}
            />
            {field.state.meta.errors.length > 0 ? (
              <p id={`${field.name}-error`} className="text-sm text-destructive">{m.server_password_required()}</p>
            ) : server?.hasPassword ? (
              <p id={`${field.name}-hint`} className="text-sm text-muted-foreground">
                {m.server_password_configured()}
              </p>
            ) : null}
            {server?.hasPassword && (
              <div className="flex flex-wrap gap-2">
                {!confirmingClear && field.state.value._tag !== "Clear" && (
                  <Button type="button" variant="outline" onClick={() => setConfirmingClear(true)}>
                    {m.server_password_clear()}
                  </Button>
                )}
                {confirmingClear && (
                  <>
                    <Button
                      type="button"
                      variant="destructive"
                      onClick={() => {
                        field.handleChange({ _tag: "Clear" })
                        setConfirmingClear(false)
                      }}
                    >
                      {m.server_password_clear_confirm()}
                    </Button>
                    <Button type="button" variant="ghost" onClick={() => setConfirmingClear(false)}>
                      {m.cancel()}
                    </Button>
                  </>
                )}
                {field.state.value._tag === "Clear" && (
                  <Button type="button" variant="outline" onClick={() => field.handleChange(preservePassword)}>
                    {m.server_password_clear_cancel()}
                  </Button>
                )}
              </div>
            )}
          </div>
        )}
      </form.Field>
      <form.Field name="userAgent">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor={field.name}>{m.server_user_agent()}</Label>
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
              <p id={`${field.name}-error`} className="text-sm text-destructive">{m.server_user_agent_required()}</p>
            )}
          </div>
        )}
      </form.Field>
      <form.Field name="enabled">
        {(field) => (
          <div className="flex items-center gap-2">
            <input
              id={field.name}
              name={field.name}
              type="checkbox"
              className="size-4 accent-primary"
              checked={field.state.value}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.checked)}
            />
            <Label htmlFor={field.name}>{m.server_enabled()}</Label>
          </div>
        )}
      </form.Field>
      {connectionState !== "idle" && (
        <p role="status" className={connectionState === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}>
          {connectionState === "pending" ? m.server_testing_connection()
            : connectionState === "success" ? m.server_test_reachable()
            : m.server_test_failed()}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting]}>
          {([canSubmit, isSubmitting]) => (
            <Button type="submit" disabled={!canSubmit || isSubmitting}>
              {isSubmitting ? m.saving() : m.save()}
            </Button>
          )}
        </form.Subscribe>
        {onTestConnection && (
          <Button
            type="button"
            variant="outline"
            disabled={connectionState === "pending"}
            onClick={() => void testConnection()}
          >
            {connectionState === "pending" ? m.server_testing_connection() : m.server_test_connection()}
          </Button>
        )}
      </div>
    </form>
  )
}

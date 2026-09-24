import { useState } from "react"
import type { PasswordChangeInput } from "@oh-my-emby/contracts"
import { PasswordChangeInput as PasswordChangeInputSchema } from "@oh-my-emby/contracts"
import { useForm } from "@tanstack/react-form"
import { Schema } from "effect"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { m } from "@/paraglide/messages.js"

type PasswordFormProps = {
  readonly onChangePassword: (input: PasswordChangeInput) => Promise<void>
  readonly onChanged?: () => void | Promise<void>
}

const passwordValidator = Schema.toStandardSchemaV1(PasswordChangeInputSchema)

export const PasswordForm = ({ onChangePassword, onChanged }: PasswordFormProps) => {
  const [formError, setFormError] = useState<string | null>(null)
  const [changed, setChanged] = useState(false)
  const form = useForm({
    defaultValues: { currentPassword: "", newPassword: "" },
    validators: { onSubmit: passwordValidator },
    onSubmit: async ({ value, formApi }) => {
      setFormError(null)
      setChanged(false)
      try {
        const input = await Schema.decodeUnknownPromise(PasswordChangeInputSchema)(value)
        await onChangePassword(input)
        formApi.reset()
        setChanged(true)
        await onChanged?.()
      } catch (error) {
        if (typeof error === "object" && error !== null && "_tag" in error && error._tag === "ParseError") return
        setFormError(m.password_change_failed())
      }
    }
  })

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
        <Alert variant="destructive" role="alert"><AlertDescription>{formError}</AlertDescription></Alert>
      )}
      {changed && <p role="status" className="text-sm text-muted-foreground">{m.password_change_success()}</p>}
      <form.Field name="currentPassword">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor={field.name}>{m.current_password()}</Label>
            <Input
              id={field.name}
              name={field.name}
              type="password"
              autoComplete="current-password"
              value={field.state.value}
              aria-invalid={field.state.meta.errors.length > 0}
              aria-describedby={field.state.meta.errors.length ? `${field.name}-error` : undefined}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
            />
            {field.state.meta.errors.length > 0 && (
              <p id={`${field.name}-error`} className="text-sm text-destructive">{m.current_password_required()}</p>
            )}
          </div>
        )}
      </form.Field>
      <form.Field name="newPassword">
        {(field) => (
          <div className="space-y-2">
            <Label htmlFor={field.name}>{m.new_password()}</Label>
            <Input
              id={field.name}
              name={field.name}
              type="password"
              autoComplete="new-password"
              value={field.state.value}
              aria-invalid={field.state.meta.errors.length > 0}
              aria-describedby={field.state.meta.errors.length ? `${field.name}-error` : undefined}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
            />
            {field.state.meta.errors.length > 0 && (
              <p id={`${field.name}-error`} className="text-sm text-destructive">{m.new_password_required()}</p>
            )}
          </div>
        )}
      </form.Field>
      <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting]}>
        {([canSubmit, isSubmitting]) => (
          <Button type="submit" disabled={!canSubmit || isSubmitting}>
            {isSubmitting ? m.changing_password() : m.change_password()}
          </Button>
        )}
      </form.Subscribe>
    </form>
  )
}

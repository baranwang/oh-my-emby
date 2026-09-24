import { useState } from "react"
import { useForm } from "@tanstack/react-form"
import { useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { login } from "@/modules/auth/services/auth-service"
import { m } from "@/paraglide/messages.js"

const errorMessage = (error: unknown) => {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    if (error._tag === "Unauthorized") return m.authentication_failed()
    if (error._tag === "HttpClientError") return m.api_unavailable_description()
  }
  return m.request_failed()
}

export const LoginPage = () => {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [formError, setFormError] = useState<string | null>(null)
  const form = useForm({
    defaultValues: { username: "", password: "" },
    onSubmit: async ({ value, formApi }) => {
      setFormError(null)
      try {
        await login(value, queryClient)
        formApi.reset()
        await navigate({ to: "/" })
      } catch (error) {
        setFormError(errorMessage(error))
      }
    }
  })

  return (
    <main id="main-content" className="grid min-h-svh place-items-center px-6 py-16">
      <div className="w-full max-w-sm space-y-8">
        <header className="space-y-2">
          <p className="text-sm font-medium text-muted-foreground">{m.app_name()}</p>
          <h1 className="font-heading text-2xl font-medium">{m.login_title()}</h1>
          <p className="text-sm leading-6 text-muted-foreground">{m.login_description()}</p>
        </header>
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
          <form.Field
            name="username"
            validators={{ onBlur: ({ value }) => value.trim() ? undefined : m.username_required() }}
          >
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
                {field.state.meta.errors[0] && (
                  <p id={`${field.name}-error`} className="text-sm text-destructive">
                    {field.state.meta.errors[0]}
                  </p>
                )}
              </div>
            )}
          </form.Field>
          <form.Field
            name="password"
            validators={{ onBlur: ({ value }) => value ? undefined : m.password_required() }}
          >
            {(field) => (
              <div className="space-y-2">
                <Label htmlFor={field.name}>{m.password_label()}</Label>
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
                {field.state.meta.errors[0] && (
                  <p id={`${field.name}-error`} className="text-sm text-destructive">
                    {field.state.meta.errors[0]}
                  </p>
                )}
              </div>
            )}
          </form.Field>
          <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting]}>
            {([canSubmit, isSubmitting]) => (
              <Button className="w-full" type="submit" disabled={!canSubmit || isSubmitting}>
                {isSubmitting ? m.login_pending() : m.login_submit()}
              </Button>
            )}
          </form.Subscribe>
        </form>
      </div>
    </main>
  )
}

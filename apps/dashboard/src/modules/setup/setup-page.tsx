import { useState } from "react"
import { useForm } from "@tanstack/react-form"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { TriangleAlertIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  bootstrapQueryOptions,
  claim,
  sessionQueryOptions
} from "@/modules/auth/services/auth-service"
import { m } from "@/paraglide/messages.js"

export const SetupPage = () => {
  const queryClient = useQueryClient()
  const bootstrap = useQuery(bootstrapQueryOptions)
  const session = useQuery({
    ...sessionQueryOptions,
    enabled: bootstrap.data?.initialized === true
  })
  const [formError, setFormError] = useState<string | null>(null)
  const form = useForm({
    defaultValues: { username: "", password: "" },
    onSubmit: async ({ value, formApi }) => {
      setFormError(null)
      try {
        await claim(value, queryClient)
        formApi.reset()
      } catch {
        setFormError(m.request_failed())
      }
    }
  })

  if (bootstrap.isPending || (bootstrap.data?.initialized && session.isPending)) {
    return <main id="main-content" className="grid min-h-svh place-items-center p-6">{m.loading()}</main>
  }

  if (bootstrap.data?.initialized && session.data?.authenticated) {
    return (
      <main id="main-content" className="grid min-h-svh place-items-center px-6 py-16">
        <div className="w-full max-w-lg space-y-4">
          <h1 className="font-heading text-2xl font-medium">{m.setup_continue_title()}</h1>
          <p className="max-w-prose text-sm leading-6 text-muted-foreground">
            {m.setup_continue_description()}
          </p>
          <Button render={<Link to="/$" params={{ _splat: "servers" }} />}>
            {m.setup_continue_action()}
          </Button>
        </div>
      </main>
    )
  }

  return (
    <main id="main-content" className="grid min-h-svh place-items-center px-6 py-16">
      <div className="w-full max-w-lg space-y-8">
        <header className="space-y-2">
          <p className="text-sm font-medium text-muted-foreground">{m.app_name()}</p>
          <h1 className="font-heading text-2xl font-medium">{m.setup_title()}</h1>
          <p className="max-w-prose text-sm leading-6 text-muted-foreground">
            {m.setup_description()}
          </p>
        </header>
        <Alert>
          <TriangleAlertIcon aria-hidden="true" />
          <AlertTitle>{m.setup_risk_title()}</AlertTitle>
          <AlertDescription>{m.setup_risk_description()}</AlertDescription>
        </Alert>
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
                  autoComplete="new-password"
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
              <Button type="submit" disabled={!canSubmit || isSubmitting}>
                {isSubmitting ? m.claim_pending() : m.claim_account()}
              </Button>
            )}
          </form.Subscribe>
        </form>
      </div>
    </main>
  )
}

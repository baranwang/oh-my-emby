import { useEffect, useRef, useState } from "react"
import type {
  ConnectionTestView,
  SecretPatch,
  ServerEndpointInput,
  ServerInput,
  ServerView,
  UserAgentPolicy
} from "@oh-my-emby/contracts"
import { ServerInput as ServerInputSchema } from "@oh-my-emby/contracts"
import { useForm } from "@tanstack/react-form"
import { Schema } from "effect"
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle
} from "@/components/ui/field"
import { InputGroup, InputGroupInput } from "@/components/ui/input-group"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { m } from "@/paraglide/messages.js"

type ServerFormProps = {
  readonly server?: ServerView
  readonly onSave: (input: ServerInput) => Promise<void>
  readonly onCancel?: () => void
  readonly onTestConnection?: () => Promise<ConnectionTestView>
}

type ServerFormValues = {
  name: string
  endpoints: Array<ServerEndpointInput>
  username: string
  password: SecretPatch
  userAgentPolicy: UserAgentPolicy
  userAgent: string | null
  enabled: boolean
}

const serverValidator = Schema.toStandardSchemaV1(ServerInputSchema)
const preservePassword: SecretPatch = { _tag: "Preserve" }
const emptyEndpoint = (): ServerEndpointInput => ({ protocol: "http", host: "", port: null, path: "" })

const endpointLabel = (index: number) => index === 0
  ? m.server_endpoint_primary()
  : m.server_endpoint_backup({ index })

const policyOptions: ReadonlyArray<{
  readonly value: UserAgentPolicy
  readonly title: () => string
  readonly description: () => string
}> = [
  {
    value: "fixed",
    title: m.server_user_agent_fixed,
    description: m.server_user_agent_fixed_description
  },
  {
    value: "client-preferred",
    title: m.server_user_agent_client_preferred,
    description: m.server_user_agent_client_preferred_description
  },
  {
    value: "passthrough",
    title: m.server_user_agent_passthrough,
    description: m.server_user_agent_passthrough_description
  }
]

const isTagged = (error: unknown, tag: string) =>
  typeof error === "object" && error !== null && "_tag" in error && error._tag === tag

export const ServerForm = ({ server, onSave, onCancel, onTestConnection }: ServerFormProps) => {
  const [formError, setFormError] = useState<string | null>(null)
  const [validationError, setValidationError] = useState(false)
  const [connectionState, setConnectionState] = useState<"idle" | "pending" | "success" | "error">("idle")
  const [connectionResult, setConnectionResult] = useState<ConnectionTestView | null>(null)
  const [connectionDetail, setConnectionDetail] = useState<string | null>(null)
  const [confirmingClear, setConfirmingClear] = useState(false)
  const formErrorRef = useRef<HTMLDivElement>(null)
  const defaultValues: ServerFormValues = {
    name: server?.name ?? "",
    endpoints: server?.endpoints.map(({ id, protocol, host, port, path }) => ({ id, protocol, host, port, path }))
      ?? [emptyEndpoint()],
    username: server?.username ?? "",
    password: preservePassword,
    userAgentPolicy: server?.userAgentPolicy ?? "fixed",
    userAgent: server?.userAgent ?? m.server_default_user_agent(),
    enabled: server?.enabled ?? true
  }
  const form = useForm({
    defaultValues,
    validators: { onSubmit: serverValidator as never },
    onSubmitInvalid: () => {
      setFormError(null)
      setValidationError(true)
    },
    onSubmit: async ({ value }) => {
      setValidationError(false)
      setFormError(null)
      try {
        const input = await Schema.decodeUnknownPromise(ServerInputSchema)(value)
        await onSave(input)
      } catch (error) {
        if (isTagged(error, "ParseError")) return
        setFormError(m.server_save_failed())
      }
    }
  })

  useEffect(() => {
    if (formError || validationError) formErrorRef.current?.focus()
  }, [formError, validationError])

  const testConnection = async () => {
    if (!onTestConnection) return
    setConnectionState("pending")
    setConnectionResult(null)
    setConnectionDetail(null)
    try {
      const result = await onTestConnection()
      setConnectionResult(result)
      setConnectionState(result.reachable ? "success" : "error")
    } catch (error) {
      setConnectionDetail(
        typeof error === "object" && error !== null && "detail" in error && typeof error.detail === "string"
          ? error.detail
          : null
      )
      setConnectionState("error")
    }
  }

  return (
    <form
      className="space-y-6"
      aria-describedby={formError || validationError ? "server-form-error" : undefined}
      onSubmit={(event) => {
        event.preventDefault()
        event.stopPropagation()
        void form.handleSubmit()
      }}
    >
      {(formError || validationError) && (
        <Alert id="server-form-error" ref={formErrorRef} tabIndex={-1} variant="destructive">
          <AlertDescription>{formError ?? m.server_validation_failed()}</AlertDescription>
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

      <form.Field name="endpoints" mode="array">
        {(endpointsField) => (
          <FieldSet>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <FieldLegend>{m.server_endpoints()}</FieldLegend>
                <FieldDescription>{m.server_endpoints_description()}</FieldDescription>
              </div>
              <Button type="button" size="sm" variant="outline" onClick={() => endpointsField.pushValue(emptyEndpoint())}>
                <PlusIcon />
                {m.server_endpoint_add()}
              </Button>
            </div>
            <div className="space-y-5">
              {endpointsField.state.value.map((endpoint, index) => {
                const label = endpointLabel(index)
                const prefix = `endpoints[${index}]` as const
                return (
                  <section
                    key={endpoint.id ?? `new-endpoint-${index}`}
                    data-endpoint-row
                    className="space-y-3 rounded-lg border p-3"
                    aria-labelledby={`${prefix}-title`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <h3 id={`${prefix}-title`} className="text-sm font-medium">{label}</h3>
                      <ButtonGroup>
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="outline"
                          aria-label={m.server_endpoint_move_up({ endpoint: label.toLocaleLowerCase() })}
                          disabled={index === 0}
                          onClick={() => endpointsField.moveValue(index, index - 1)}
                        >
                          <ArrowUpIcon />
                        </Button>
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="outline"
                          aria-label={m.server_endpoint_move_down({ endpoint: label.toLocaleLowerCase() })}
                          disabled={index === endpointsField.state.value.length - 1}
                          onClick={() => endpointsField.moveValue(index, index + 1)}
                        >
                          <ArrowDownIcon />
                        </Button>
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="outline"
                          aria-label={m.server_endpoint_remove({ endpoint: label.toLocaleLowerCase() })}
                          disabled={endpointsField.state.value.length === 1}
                          onClick={() => endpointsField.removeValue(index)}
                        >
                          <Trash2Icon />
                        </Button>
                      </ButtonGroup>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-[7rem_minmax(0,1fr)]">
                      <form.Field name={`${prefix}.protocol`}>
                        {(field) => (
                          <div className="space-y-2">
                            <Label htmlFor={field.name}>{m.server_endpoint_protocol()}</Label>
                            <Select
                              value={field.state.value}
                              onValueChange={(value) => value && field.handleChange(value as "http" | "https")}
                            >
                              <SelectTrigger id={field.name} className="w-full">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="http">HTTP</SelectItem>
                                <SelectItem value="https">HTTPS</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                        )}
                      </form.Field>
                      <form.Field name={`${prefix}.host`}>
                        {(field) => {
                          const invalid = field.state.meta.errors.length > 0
                          return (
                            <div className="space-y-2">
                              <Label htmlFor={field.name}>{label} {m.server_endpoint_host().toLocaleLowerCase()}</Label>
                              <InputGroup>
                                <InputGroupInput
                                  id={field.name}
                                  name={field.name}
                                  inputMode="url"
                                  autoCapitalize="none"
                                  autoCorrect="off"
                                  placeholder={m.server_endpoint_host_placeholder()}
                                  value={field.state.value}
                                  aria-invalid={invalid}
                                  aria-describedby={invalid ? `${field.name}-error` : undefined}
                                  onBlur={field.handleBlur}
                                  onChange={(event) => field.handleChange(event.target.value)}
                                />
                              </InputGroup>
                              {invalid && (
                                <p id={`${field.name}-error`} className="text-sm text-destructive">
                                  {m.server_endpoint_invalid({ endpoint: label })}
                                </p>
                              )}
                            </div>
                          )
                        }}
                      </form.Field>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-[7rem_minmax(0,1fr)]">
                      <form.Field name={`${prefix}.port`}>
                        {(field) => {
                          const invalid = field.state.meta.errors.length > 0
                          return (
                            <div className="space-y-2">
                              <Label htmlFor={field.name}>{label} {m.server_endpoint_port().toLocaleLowerCase()}</Label>
                              <InputGroup>
                                <InputGroupInput
                                  id={field.name}
                                  name={field.name}
                                  inputMode="numeric"
                                  placeholder="8096"
                                  value={field.state.value ?? ""}
                                  aria-invalid={invalid}
                                  aria-describedby={invalid ? `${field.name}-error` : undefined}
                                  onBlur={field.handleBlur}
                                  onChange={(event) => {
                                    const digits = event.target.value.replace(/\D/g, "")
                                    field.handleChange(digits === "" ? null : Number(digits))
                                  }}
                                />
                              </InputGroup>
                              {invalid && (
                                <p id={`${field.name}-error`} className="text-sm text-destructive">
                                  {m.server_endpoint_invalid({ endpoint: label })}
                                </p>
                              )}
                            </div>
                          )
                        }}
                      </form.Field>
                      <form.Field name={`${prefix}.path`}>
                        {(field) => {
                          const invalid = field.state.meta.errors.length > 0
                          return (
                            <div className="space-y-2">
                              <Label htmlFor={field.name}>{label} {m.server_endpoint_path().toLocaleLowerCase()}</Label>
                              <InputGroup>
                                <InputGroupInput
                                  id={field.name}
                                  name={field.name}
                                  placeholder={m.server_endpoint_path_placeholder()}
                                  value={field.state.value}
                                  aria-invalid={invalid}
                                  aria-describedby={invalid ? `${field.name}-error` : undefined}
                                  onBlur={field.handleBlur}
                                  onChange={(event) => field.handleChange(event.target.value)}
                                />
                              </InputGroup>
                              {invalid && (
                                <p id={`${field.name}-error`} className="text-sm text-destructive">
                                  {m.server_endpoint_invalid({ endpoint: label })}
                                </p>
                              )}
                            </div>
                          )
                        }}
                      </form.Field>
                    </div>
                  </section>
                )
              })}
            </div>
          </FieldSet>
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
                field.handleChange(event.target.value ? { _tag: "Set", value: event.target.value } : preservePassword)
              }}
            />
            {field.state.meta.errors.length > 0 ? (
              <p id={`${field.name}-error`} className="text-sm text-destructive">{m.server_password_required()}</p>
            ) : server?.hasPassword ? (
              <p id={`${field.name}-hint`} className="text-sm text-muted-foreground">{m.server_password_configured()}</p>
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
                    <Button type="button" variant="ghost" onClick={() => setConfirmingClear(false)}>{m.cancel()}</Button>
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

      <form.Field name="userAgentPolicy">
        {(policyField) => (
          <FieldSet>
            <FieldLegend>{m.server_user_agent()}</FieldLegend>
            <RadioGroup
              value={policyField.state.value}
              onValueChange={(value) => {
                if (!value) return
                const policy = value as UserAgentPolicy
                policyField.handleChange(policy)
                if (policy === "passthrough") form.setFieldValue("userAgent", null)
                if (policy === "fixed" && form.state.values.userAgent === null) {
                  form.setFieldValue("userAgent", m.server_default_user_agent())
                }
              }}
            >
              {policyOptions.map((option) => (
                <FieldLabel key={option.value} htmlFor={`user-agent-${option.value}`}>
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldTitle>{option.title()}</FieldTitle>
                      <FieldDescription>{option.description()}</FieldDescription>
                    </FieldContent>
                    <RadioGroupItem id={`user-agent-${option.value}`} value={option.value} />
                  </Field>
                </FieldLabel>
              ))}
            </RadioGroup>
          </FieldSet>
        )}
      </form.Field>

      <form.Subscribe selector={(state) => state.values.userAgentPolicy}>
        {(policy) => policy !== "passthrough" && (
          <form.Field name="userAgent">
            {(field) => {
              const invalid = field.state.meta.errors.length > 0
              const label = policy === "fixed"
                ? m.server_user_agent_fixed_value()
                : m.server_user_agent_fallback_value()
              return (
                <div className="space-y-2">
                  <Label htmlFor={field.name}>{label}</Label>
                  <Input
                    id={field.name}
                    name={field.name}
                    value={field.state.value ?? ""}
                    aria-invalid={invalid}
                    aria-describedby={invalid ? `${field.name}-error` : undefined}
                    onBlur={field.handleBlur}
                    onChange={(event) => field.handleChange(event.target.value || null)}
                  />
                  {invalid && (
                    <p id={`${field.name}-error`} className="text-sm text-destructive">{m.server_user_agent_required()}</p>
                  )}
                </div>
              )
            }}
          </form.Field>
        )}
      </form.Subscribe>

      <form.Field name="enabled">
        {(field) => (
          <FieldLabel htmlFor={field.name}>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldTitle>{m.server_enabled()}</FieldTitle>
              </FieldContent>
              <Switch
                id={field.name}
                checked={field.state.value}
                onCheckedChange={field.handleChange}
              />
            </Field>
          </FieldLabel>
        )}
      </form.Field>

      {connectionState !== "idle" && (
        <section className="space-y-3" aria-labelledby="server-test-results">
          <p
            id="server-test-results"
            role="status"
            className={connectionState === "error" ? "text-sm text-destructive" : "text-sm text-muted-foreground"}
          >
            {connectionState === "pending" ? m.server_testing_connection()
              : connectionState === "success" ? m.server_test_reachable()
              : m.server_test_failed()}
          </p>
          {connectionResult && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium">{m.server_test_results()}</h3>
              <ul className="divide-y rounded-lg border">
                {server?.endpoints.map((endpoint) => {
                  const result = connectionResult.endpoints.find((item) => item.endpointId === endpoint.id)
                  return (
                    <li key={endpoint.id} data-connection-result className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                      <span className="min-w-0 truncate">{endpoint.displayUrl}</span>
                      <span className="shrink-0 text-muted-foreground">
                        {result?.reachable ? m.server_test_endpoint_reachable() : m.server_test_endpoint_unreachable()}
                      </span>
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
          {connectionDetail && <p className="break-words text-sm text-destructive">{connectionDetail}</p>}
        </section>
      )}

      <div className="flex flex-wrap justify-end gap-2">
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
        {onCancel && <Button type="button" variant="outline" onClick={onCancel}>{m.cancel()}</Button>}
        <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting]}>
          {([canSubmit, isSubmitting]) => (
            <Button type="submit" disabled={!canSubmit || isSubmitting}>
              {isSubmitting ? m.saving() : m.save()}
            </Button>
          )}
        </form.Subscribe>
      </div>
    </form>
  )
}

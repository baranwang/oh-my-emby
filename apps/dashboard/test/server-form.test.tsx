import { act, type ReactElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import type { ServerInput, ServerView } from "@oh-my-emby/contracts"
import { afterEach, describe, expect, it, vi } from "vitest"

import { PasswordForm } from "../src/modules/auth/components/password-form.js"
import { ServerForm } from "../src/modules/servers/components/server-form.js"
import { m } from "../src/paraglide/messages.js"

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const configuredServer = {
  id: "server-1",
  name: "Home",
  baseUrl: "https://emby.example.com",
  username: "alice",
  hasPassword: true,
  userAgent: "SenPlayer/1",
  enabled: true,
  verifiedCatalogId: "catalog-1",
  generation: 1,
  health: "healthy"
} as ServerView

const mounted: Array<{ container: HTMLDivElement; root: Root }> = []

const render = async (element: ReactElement) => {
  const container = document.body.appendChild(document.createElement("div"))
  const root = createRoot(container)
  mounted.push({ container, root })
  await act(async () => root.render(element))
  return container
}

const byLabel = (container: HTMLElement, label: string) => {
  const element = [...container.querySelectorAll("label")]
    .find((candidate) => candidate.textContent?.includes(label))
  const target = element?.htmlFor ? container.querySelector(`#${CSS.escape(element.htmlFor)}`) : null
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) {
    throw new Error(`Control not found for label: ${label}`)
  }
  return target
}

const byButton = (container: HTMLElement, name: string) => {
  const button = [...container.querySelectorAll("button")]
    .find((candidate) => candidate.textContent?.includes(name))
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Button not found: ${name}`)
  return button
}

const change = async (control: HTMLInputElement | HTMLSelectElement, value: string | boolean) => {
  await act(async () => {
    if (control instanceof HTMLInputElement && control.type === "checkbox") {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked")?.set?.call(control, value)
      control.dispatchEvent(new Event("change", { bubbles: true }))
      control.dispatchEvent(new Event("click", { bubbles: true }))
      return
    }
    const prototype = control instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLSelectElement.prototype
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(control, value)
    control.dispatchEvent(new Event("input", { bubbles: true }))
    control.dispatchEvent(new Event("change", { bubbles: true }))
  })
}

const click = async (button: HTMLButtonElement) => {
  await act(async () => {
    button.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

afterEach(async () => {
  while (mounted.length) {
    const item = mounted.pop()
    if (!item) continue
    await act(async () => item.root.unmount())
    item.container.remove()
  }
})

describe("server credentials", () => {
  it("preserves a configured password when the edit field stays empty", async () => {
    const onSave = vi.fn<(input: ServerInput) => Promise<void>>().mockResolvedValue(undefined)
    const container = await render(<ServerForm server={configuredServer} onSave={onSave} />)

    await click(byButton(container, m.save()))

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      password: { _tag: "Preserve" }
    }))
  })

  it("clears a configured password only after dedicated confirmation", async () => {
    const onSave = vi.fn<(input: ServerInput) => Promise<void>>().mockResolvedValue(undefined)
    const container = await render(<ServerForm server={configuredServer} onSave={onSave} />)

    await click(byButton(container, m.server_password_clear()))
    expect(byButton(container, m.server_password_clear_confirm()).disabled).toBe(false)
    await click(byButton(container, m.server_password_clear_confirm()))
    await click(byButton(container, m.save()))

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ password: { _tag: "Clear" } }))
  })

  it("sets the password only when a new value is entered", async () => {
    const onSave = vi.fn<(input: ServerInput) => Promise<void>>().mockResolvedValue(undefined)
    const container = await render(<ServerForm server={configuredServer} onSave={onSave} />)

    await change(byLabel(container, m.server_password()), "replacement-secret")
    await click(byButton(container, m.save()))

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      password: { _tag: "Set", value: "replacement-secret" }
    }))
  })

  it("keeps save available after a failed connection test", async () => {
    const onSave = vi.fn<(input: ServerInput) => Promise<void>>().mockResolvedValue(undefined)
    const onTestConnection = vi.fn().mockRejectedValue(new Error("offline"))
    const container = await render(
      <ServerForm server={configuredServer} onSave={onSave} onTestConnection={onTestConnection} />
    )

    await click(byButton(container, m.server_test_connection()))
    expect(container.querySelector('[role="status"]')?.textContent)
      .toContain(m.server_test_failed())

    await click(byButton(container, m.save()))
    expect(onSave).toHaveBeenCalledOnce()
  })

  it("uses the shared Effect Standard Schema for field errors and a separate non-field alert", async () => {
    const onSave = vi.fn<(input: ServerInput) => Promise<void>>().mockRejectedValue(new Error("failed"))
    const container = await render(<ServerForm server={configuredServer} onSave={onSave} />)
    const baseUrl = byLabel(container, m.server_base_url()) as HTMLInputElement

    await change(baseUrl, "ftp://invalid.example.com")
    await click(byButton(container, m.save()))

    expect(baseUrl.getAttribute("aria-invalid")).toBe("true")
    expect(document.getElementById(baseUrl.getAttribute("aria-describedby") ?? "")?.textContent)
      .toBe(m.server_base_url_invalid())
    expect(container.querySelector('[role="alert"]')).toBeNull()

    await change(baseUrl, "https://valid.example.com")
    await click(byButton(container, m.save()))
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(m.server_save_failed())
  })
})

it("changes the local password with validated current and new values", async () => {
  const onChangePassword = vi.fn().mockResolvedValue(undefined)
  const container = await render(<PasswordForm onChangePassword={onChangePassword} />)

  await change(byLabel(container, m.current_password()), "current-secret")
  await change(byLabel(container, m.new_password()), "new-secret")
  await click(byButton(container, m.change_password()))

  expect(onChangePassword).toHaveBeenCalledWith({
    currentPassword: "current-secret",
    newPassword: "new-secret"
  })
})

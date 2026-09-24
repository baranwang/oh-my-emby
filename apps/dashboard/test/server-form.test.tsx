import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ConnectionTestView, ServerInput, ServerView } from "@oh-my-emby/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ServerForm } from "../src/modules/servers/components/server-form.js";
import { m } from "../src/paraglide/messages.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const configuredServer = {
  id: "server-1",
  name: "Home",
  endpoints: [
    {
      id: "endpoint-1",
      protocol: "https",
      host: "primary.example.com",
      port: 443,
      path: "/emby",
      displayUrl: "https://primary.example.com:443/emby",
      verifiedCatalogId: "catalog-1",
      health: "healthy",
      lastSuccessAtMs: 1,
    },
    {
      id: "endpoint-2",
      protocol: "http",
      host: "backup.example.com",
      port: 8096,
      path: "",
      displayUrl: "http://backup.example.com:8096/",
      verifiedCatalogId: "catalog-1",
      health: "degraded",
      lastSuccessAtMs: null,
    },
  ],
  username: "alice",
  hasPassword: true,
  userAgentPolicy: "fixed",
  userAgent: "SenPlayer/1",
  enabled: true,
  verifiedCatalogId: "catalog-1",
  generation: 1,
  health: "healthy",
} as ServerView;

const mounted: Array<{ container: HTMLDivElement; root: Root }> = [];

const render = async (element: ReactElement) => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  mounted.push({ container, root });
  await act(async () => root.render(element));
  return container;
};

const byLabel = (container: HTMLElement, label: string) => {
  const element = [...container.querySelectorAll("label")].find((candidate) =>
    candidate.textContent?.includes(label),
  );
  const target = element?.htmlFor
    ? container.querySelector(`#${CSS.escape(element.htmlFor)}`)
    : null;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLButtonElement)) {
    throw new Error(`Control not found for label: ${label}`);
  }
  return target;
};

const byButton = (container: HTMLElement, name: string) => {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) =>
      candidate.textContent?.includes(name) || candidate.getAttribute("aria-label") === name,
  );
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Button not found: ${name}`);
  return button;
};

const change = async (control: HTMLInputElement, value: string | boolean) => {
  await act(async () => {
    if (control.type === "checkbox") {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked")?.set?.call(
        control,
        value,
      );
      control.dispatchEvent(new Event("change", { bubbles: true }));
      control.dispatchEvent(new Event("click", { bubbles: true }));
      return;
    }
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(control, value);
    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
  });
};

const click = async (button: HTMLButtonElement | HTMLInputElement) => {
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

afterEach(async () => {
  while (mounted.length) {
    const item = mounted.pop();
    if (!item) continue;
    await act(async () => item.root.unmount());
    item.container.remove();
  }
});

describe("server endpoints", () => {
  it("edits one address input group and changes HTTPS without losing the address segments", async () => {
    const onSave = vi.fn<(input: ServerInput) => Promise<void>>().mockResolvedValue(undefined);
    const container = await render(<ServerForm server={configuredServer} onSave={onSave} />);
    const host = byLabel(container, "Primary endpoint host") as HTMLInputElement;
    const port = byLabel(container, "Primary endpoint port") as HTMLInputElement;
    const path = byLabel(container, "Primary endpoint path") as HTMLInputElement;
    const group = host.closest('[data-slot="input-group"]');

    expect(group).not.toBeNull();
    expect(port.closest('[data-slot="input-group"]')).toBe(group);
    expect(path.closest('[data-slot="input-group"]')).toBe(group);
    expect(path.value).toBe("emby");
    const https = byLabel(container, "Primary endpoint Use HTTPS") as HTMLInputElement;
    expect(https.checked).toBe(true);
    await act(async () => https.click());
    expect(https.checked).toBe(false);
    await change(host, "edited.example.com");
    await change(port, "8097");
    await change(path, "media");
    await click(byButton(container, m.save()));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoints: [
          {
            id: "endpoint-1",
            protocol: "http",
            host: "edited.example.com",
            port: 8097,
            path: "/media",
          },
          { id: "endpoint-2", protocol: "http", host: "backup.example.com", port: 8096, path: "" },
        ],
      }),
    );
  });

  it("submits the http endpoint default and exposes the 8096 port placeholder", async () => {
    const onSave = vi.fn<(input: ServerInput) => Promise<void>>().mockResolvedValue(undefined);
    const container = await render(<ServerForm onSave={onSave} />);
    const host = byLabel(container, "Primary endpoint host") as HTMLInputElement;
    const port = byLabel(container, "Primary endpoint port") as HTMLInputElement;

    expect(port.placeholder).toBe("8096");
    expect((byLabel(container, "Primary endpoint Use HTTPS") as HTMLInputElement).checked).toBe(
      false,
    );
    await change(byLabel(container, m.server_name()) as HTMLInputElement, "Home");
    await change(host, "emby.example.com");
    await change(byLabel(container, m.username_label()) as HTMLInputElement, "alice");
    await change(byLabel(container, m.server_password()) as HTMLInputElement, "secret");
    await click(byButton(container, m.save()));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoints: [{ protocol: "http", host: "emby.example.com", port: null, path: "" }],
      }),
    );
  });

  it("adds, removes, and reorders endpoint rows without changing their values", async () => {
    const onSave = vi.fn<(input: ServerInput) => Promise<void>>().mockResolvedValue(undefined);
    const container = await render(<ServerForm server={configuredServer} onSave={onSave} />);

    await click(byButton(container, "Add endpoint"));
    expect(container.querySelectorAll("[data-endpoint-row]")).toHaveLength(3);
    await change(
      byLabel(container, "Backup endpoint 2 host") as HTMLInputElement,
      "third.example.com",
    );
    await click(byButton(container, "Move backup endpoint 2 up"));
    await click(byButton(container, "Remove backup endpoint 2"));
    await click(byButton(container, m.save()));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoints: [
          expect.objectContaining({ host: "primary.example.com" }),
          expect.objectContaining({ host: "third.example.com" }),
        ],
      }),
    );
  });

  it("associates an endpoint-specific validation error with the invalid host", async () => {
    const container = await render(<ServerForm server={configuredServer} onSave={vi.fn()} />);
    const host = byLabel(container, "Backup endpoint 1 host") as HTMLInputElement;

    await change(host, "https://not-a-host.example.com");
    await click(byButton(container, m.save()));

    expect(host.getAttribute("aria-invalid")).toBe("true");
    expect(
      document.getElementById(host.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toContain("Backup endpoint 1");
  });

  it("focuses an accessible validation summary for duplicate canonical endpoints", async () => {
    const onSave = vi.fn<(input: ServerInput) => Promise<void>>().mockResolvedValue(undefined);
    const duplicateEndpointServer = {
      ...configuredServer,
      endpoints: [
        configuredServer.endpoints[0],
        {
          ...configuredServer.endpoints[1],
          protocol: "https",
          host: "PRIMARY.EXAMPLE.COM",
          port: 443,
          path: "/emby",
        },
      ],
    } as ServerView;
    const container = await render(<ServerForm server={duplicateEndpointServer} onSave={onSave} />);

    await click(byButton(container, m.save()));

    const summary = container.querySelector('[role="alert"]');
    const form = container.querySelector("form");
    expect(onSave).not.toHaveBeenCalled();
    expect(summary).toBeInstanceOf(HTMLElement);
    expect(document.activeElement).toBe(summary);
    expect(form?.getAttribute("aria-describedby")).toBe(summary?.id);
  });
});

describe("server User-Agent policy", () => {
  it("defaults new servers to the first client-preferred choice and submits it unchanged", async () => {
    const onSave = vi.fn<(input: ServerInput) => Promise<void>>().mockResolvedValue(undefined);
    const container = await render(<ServerForm onSave={onSave} />);
    const firstChoice = container.querySelector<HTMLInputElement>('input[type="radio"]');

    expect(firstChoice?.id).toBe("user-agent-client-preferred");
    expect(firstChoice?.checked).toBe(true);
    expect(byLabel(container, m.server_user_agent_fallback_value())).toBeInstanceOf(
      HTMLInputElement,
    );

    await change(byLabel(container, m.server_name()) as HTMLInputElement, "Home");
    await change(
      byLabel(container, "Primary endpoint host") as HTMLInputElement,
      "emby.example.com",
    );
    await change(byLabel(container, m.username_label()) as HTMLInputElement, "alice");
    await change(byLabel(container, m.server_password()) as HTMLInputElement, "secret");
    await click(byButton(container, m.save()));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ userAgentPolicy: "client-preferred" }),
    );
  });

  it("renders exactly three Field choice cards and the policy-specific value field", async () => {
    const container = await render(<ServerForm server={configuredServer} onSave={vi.fn()} />);
    const radios = [...container.querySelectorAll('[role="radio"]')];

    expect(radios).toHaveLength(3);
    expect(container.textContent).toContain("Fixed override");
    expect(container.textContent).toContain("Client preferred");
    expect(container.textContent).toContain("Passthrough");
    expect((byLabel(container, m.server_user_agent_fixed()) as HTMLInputElement).checked).toBe(
      true,
    );
    expect(byLabel(container, "Fixed User-Agent")).toBeInstanceOf(HTMLInputElement);

    await click(byLabel(container, m.server_user_agent_passthrough()));
    expect(container.textContent).not.toContain("Fixed User-Agent");
    expect(container.textContent).not.toContain("Fallback User-Agent");

    await click(byLabel(container, m.server_user_agent_client_preferred()));
    expect(byLabel(container, "Fallback User-Agent")).toBeInstanceOf(HTMLInputElement);
  });

  it("focuses an accessible validation summary when fixed User-Agent is empty", async () => {
    const onSave = vi.fn<(input: ServerInput) => Promise<void>>().mockResolvedValue(undefined);
    const container = await render(<ServerForm server={configuredServer} onSave={onSave} />);

    await change(byLabel(container, "Fixed User-Agent") as HTMLInputElement, "");
    await click(byButton(container, m.save()));

    const summary = container.querySelector('[role="alert"]');
    const form = container.querySelector("form");
    expect(onSave).not.toHaveBeenCalled();
    expect(summary).toBeInstanceOf(HTMLElement);
    expect(document.activeElement).toBe(summary);
    expect(form?.getAttribute("aria-describedby")).toBe(summary?.id);
  });
});

describe("server credentials and failures", () => {
  it.each(["", "   "])("submits a cleared name for backend discovery: %j", async (name) => {
    const onSave = vi.fn<(input: ServerInput) => Promise<void>>().mockResolvedValue(undefined);
    const container = await render(<ServerForm server={configuredServer} onSave={onSave} />);

    await change(byLabel(container, m.server_name()) as HTMLInputElement, name);
    await click(byButton(container, m.save()));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ name }));
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("submits a new server with its name left blank", async () => {
    const onSave = vi.fn<(input: ServerInput) => Promise<void>>().mockResolvedValue(undefined);
    const container = await render(<ServerForm onSave={onSave} />);

    await change(
      byLabel(container, "Primary endpoint host") as HTMLInputElement,
      "emby.example.com",
    );
    await change(byLabel(container, m.username_label()) as HTMLInputElement, "alice");
    await change(byLabel(container, m.server_password()) as HTMLInputElement, "secret");
    await click(byButton(container, m.save()));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ name: "" }));
  });

  it("opts upstream credentials out of autofill without treating them as dashboard login fields", async () => {
    const container = await render(<ServerForm server={configuredServer} onSave={vi.fn()} />);
    const username = byLabel(container, m.username_label()) as HTMLInputElement;
    const password = byLabel(container, m.server_password()) as HTMLInputElement;

    expect(password.form?.getAttribute("autocomplete")).toBe("off");
    expect(username.name).toBe("upstream-username");
    expect(password.name).toBe("upstream-password");
    for (const input of [username, password]) {
      expect(input.autocomplete).toBe("off");
      expect(input.getAttribute("data-1p-ignore")).toBe("true");
      expect(input.getAttribute("data-lpignore")).toBe("true");
    }
    expect(password.type).toBe("password");
    expect(password.value).toBe("");
  });

  it("preserves, sets, and clears a configured password explicitly", async () => {
    const onSave = vi.fn<(input: ServerInput) => Promise<void>>().mockResolvedValue(undefined);
    const container = await render(<ServerForm server={configuredServer} onSave={onSave} />);

    await click(byButton(container, m.save()));
    expect(onSave).toHaveBeenLastCalledWith(
      expect.objectContaining({ password: { _tag: "Preserve" } }),
    );

    await change(byLabel(container, m.server_password()) as HTMLInputElement, "replacement-secret");
    await click(byButton(container, m.save()));
    expect(onSave).toHaveBeenLastCalledWith(
      expect.objectContaining({
        password: { _tag: "Set", value: "replacement-secret" },
      }),
    );

    await change(byLabel(container, m.server_password()) as HTMLInputElement, "");
    await click(byButton(container, m.server_password_clear()));
    await click(byButton(container, m.server_password_clear_confirm()));
    await click(byButton(container, m.save()));
    expect(onSave).toHaveBeenLastCalledWith(
      expect.objectContaining({ password: { _tag: "Clear" } }),
    );
  });

  it("retains edited values and save availability after connection and save failures", async () => {
    const onSave = vi
      .fn<(input: ServerInput) => Promise<void>>()
      .mockRejectedValue(new Error("failed"));
    const onTestConnection = vi
      .fn<() => Promise<ConnectionTestView>>()
      .mockRejectedValue(new Error("offline"));
    const container = await render(
      <ServerForm server={configuredServer} onSave={onSave} onTestConnection={onTestConnection} />,
    );
    const name = byLabel(container, m.server_name()) as HTMLInputElement;

    await change(name, "Edited locally");
    await click(byButton(container, m.server_test_connection()));
    expect(name.value).toBe("Edited locally");
    await click(byButton(container, m.save()));
    expect(name.value).toBe("Edited locally");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      m.server_save_failed(),
    );
  });

  it("renders connection results in configured endpoint order", async () => {
    const onTestConnection = vi.fn<() => Promise<ConnectionTestView>>().mockResolvedValue({
      reachable: true,
      catalogId: "catalog-1",
      endpoints: [
        { endpointId: "endpoint-2", reachable: false, catalogId: null, health: "degraded" },
        { endpointId: "endpoint-1", reachable: true, catalogId: "catalog-1", health: "healthy" },
      ],
    });
    const container = await render(
      <ServerForm server={configuredServer} onSave={vi.fn()} onTestConnection={onTestConnection} />,
    );

    await click(byButton(container, m.server_test_connection()));
    const rows = [...container.querySelectorAll("[data-connection-result]")];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("primary.example.com");
    expect(rows[1]?.textContent).toContain("backup.example.com");
  });

  it("reports a fulfilled unreachable connection test as failed and preserves endpoint order", async () => {
    const onTestConnection = vi.fn<() => Promise<ConnectionTestView>>().mockResolvedValue({
      reachable: false,
      catalogId: null,
      endpoints: [
        { endpointId: "endpoint-1", reachable: false, catalogId: null, health: "degraded" },
        { endpointId: "endpoint-2", reachable: false, catalogId: null, health: "unknown" },
      ],
    });
    const container = await render(
      <ServerForm server={configuredServer} onSave={vi.fn()} onTestConnection={onTestConnection} />,
    );

    await click(byButton(container, m.server_test_connection()));

    const status = container.querySelector('[role="status"]');
    const rows = [...container.querySelectorAll("[data-connection-result]")];
    expect(status?.textContent).toContain(m.server_test_failed());
    expect(status?.textContent).not.toContain(m.server_test_reachable());
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("primary.example.com");
    expect(rows[1]?.textContent).toContain("backup.example.com");
  });
});

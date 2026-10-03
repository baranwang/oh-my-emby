import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ConnectionTestView, ServerInput, ServerView } from "@oh-my-emby/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ServerForm } from "../src/modules/servers/components/server-form.js";
import { ServerDiscoveryError } from "../src/modules/servers/services/server-service.js";
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
    control.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
  });
};

const click = async (button: HTMLElement) => {
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
  it.each(["Infuse-Direct/8.5.6", "Rex-Standard/0.5.0", "SenPlayer/6.2.2", "VidHub/3.0.0"])(
    "offers all four UA presets and saves the selected %s",
    async (userAgent) => {
      const onSave = vi.fn<(input: ServerInput) => Promise<void>>().mockResolvedValue(undefined);
      const container = await render(<ServerForm server={configuredServer} onSave={onSave} />);
      const input = byLabel(container, m.server_user_agent_fixed_value()) as HTMLInputElement;
      expect(input.getAttribute("role")).toBe("combobox");
      expect(input.value).toBe("SenPlayer/1");
      await act(async () => {
        input.focus();
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      });
      const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
      expect(options.map((option) => option.textContent)).toEqual([
        "Infuse-Direct/8.5.6",
        "Rex-Standard/0.5.0",
        "SenPlayer/6.2.2",
        "VidHub/3.0.0",
      ]);
      await click(options.find((option) => option.textContent === userAgent)!);
      expect(input.value).toBe(userAgent);
      await click(byButton(container, m.save()));
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ userAgentPolicy: "fixed", userAgent }),
      );
    },
  );

  it.each(["fixed", "client-preferred"] as const)(
    "preserves a custom UA through blur and saves it with the %s policy",
    async (userAgentPolicy) => {
      const onSave = vi.fn<(input: ServerInput) => Promise<void>>().mockResolvedValue(undefined);
      const container = await render(
        <ServerForm server={{ ...configuredServer, userAgentPolicy }} onSave={onSave} />,
      );
      const input = byLabel(
        container,
        userAgentPolicy === "fixed"
          ? m.server_user_agent_fixed_value()
          : m.server_user_agent_fallback_value(),
      ) as HTMLInputElement;
      expect(input.getAttribute("role")).toBe("combobox");
      await act(async () => input.focus());
      await change(input, "MyCustomPlayer/2.0");
      await act(async () => input.blur());
      expect(input.value).toBe("MyCustomPlayer/2.0");
      await click(byButton(container, m.save()));
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ userAgentPolicy, userAgent: "MyCustomPlayer/2.0" }),
      );
    },
  );

  it("filters UA presets and selects a search result with the keyboard", async () => {
    const onSave = vi.fn<(input: ServerInput) => Promise<void>>().mockResolvedValue(undefined);
    const container = await render(<ServerForm server={configuredServer} onSave={onSave} />);
    const input = byLabel(container, m.server_user_agent_fixed_value()) as HTMLInputElement;
    expect(input.getAttribute("role")).toBe("combobox");
    await act(async () => input.focus());
    await change(input, "rex");
    expect(
      [...document.querySelectorAll('[role="option"]')].map((option) => option.textContent),
    ).toEqual(["Rex-Standard/0.5.0"]);
    for (const key of ["ArrowDown", "Enter"]) {
      await act(async () => {
        input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      });
    }
    expect(input.value).toBe("Rex-Standard/0.5.0");
    expect(onSave).not.toHaveBeenCalled();
    await click(byButton(container, m.save()));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ userAgent: "Rex-Standard/0.5.0" }),
    );
  });

  it("shows the presets when an empty fallback switches back to fixed User-Agent", async () => {
    const container = await render(<ServerForm server={configuredServer} onSave={vi.fn()} />);
    await click(byLabel(container, m.server_user_agent_client_preferred()));
    await change(byLabel(container, m.server_user_agent_fallback_value()) as HTMLInputElement, "");
    await click(byLabel(container, m.server_user_agent_fixed()));
    const input = byLabel(container, m.server_user_agent_fixed_value()) as HTMLInputElement;
    expect(input.value).toBe("Infuse-Direct/8.5.6");
    await act(async () => {
      input.focus();
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(
      [...document.querySelectorAll('[role="option"]')].map((option) => option.textContent),
    ).toEqual(["Infuse-Direct/8.5.6", "Rex-Standard/0.5.0", "SenPlayer/6.2.2", "VidHub/3.0.0"]);
  });

  it.each(["passthrough", "client-preferred"] as const)(
    "preserves an empty saved User-Agent when reopening a %s server",
    async (userAgentPolicy) => {
      const onSave = vi.fn<(input: ServerInput) => Promise<void>>().mockResolvedValue(undefined);
      const savedServer = { ...configuredServer, userAgentPolicy, userAgent: null };
      const container = await render(<ServerForm server={savedServer} onSave={onSave} />);

      await click(byButton(container, m.save()));

      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({
          userAgentPolicy,
          userAgent: null,
          password: { _tag: "Preserve" },
        }),
      );
      expect(container.querySelector('[role="alert"]')).toBeNull();
    },
  );

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

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ name: "", userAgent: "Infuse-Direct/8.5.6" }),
    );
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

  it.each(["save", "test"])(
    "explains a 497 failure during %s without displaying an HTML error page",
    async (action) => {
      const cause = {
        _tag: "UpstreamRejected",
        serverId: configuredServer.id,
        status: 497,
        detail:
          "<!DOCTYPE HTML><html><style>body { color: red; }</style><script>window.__ESA_ERROR_PAGE_INFO = { http_status: 497 };</script></html>",
      };
      const onSave = vi
        .fn()
        .mockRejectedValue(new ServerDiscoveryError(configuredServer, "connection", cause));
      const onTestConnection = vi.fn().mockRejectedValue(cause);
      const container = await render(
        <ServerForm
          server={configuredServer}
          onSave={onSave}
          onTestConnection={onTestConnection}
        />,
      );

      await click(byButton(container, action === "save" ? m.save() : m.server_test_connection()));

      expect(container.textContent).toContain("497");
      expect(container.textContent).toContain("HTTPS");
      expect(container.textContent).not.toContain("<!DOCTYPE");
      expect(container.textContent).not.toContain("window.__ESA_ERROR_PAGE_INFO");
      if (action === "save") {
        expect(container.querySelector('[role="alert"]')?.textContent).toContain(
          "Configuration saved",
        );
      }
    },
  );

  it.each(["save", "test"])(
    "keeps long diagnostic details collapsed during %s failures",
    async (action) => {
      const cause = {
        _tag: "UpstreamRejected",
        serverId: configuredServer.id,
        status: 403,
        detail: `blocked by upstream: ${"diagnostic ".repeat(350)}`,
      };
      const onSave = vi
        .fn()
        .mockRejectedValue(new ServerDiscoveryError(configuredServer, "connection", cause));
      const onTestConnection = vi.fn().mockRejectedValue(cause);
      const container = await render(
        <ServerForm
          server={configuredServer}
          onSave={onSave}
          onTestConnection={onTestConnection}
        />,
      );

      await click(byButton(container, action === "save" ? m.save() : m.server_test_connection()));

      const details = container.querySelector("details");
      expect(details).toBeInstanceOf(HTMLDetailsElement);
      expect(details?.open).toBe(false);
      expect(details?.querySelector("summary")?.textContent).toContain("response details");
      expect(details?.querySelector("pre")?.textContent).toContain("blocked by upstream");
      expect(details?.parentElement?.textContent).toContain("403");
    },
  );

  it.each([
    [{ _tag: "UpstreamRejected", status: 401 }, /username and password/i],
    [{ _tag: "UpstreamRejected", status: 404 }, /base path/i],
    [{ _tag: "UpstreamRejected", status: 502 }, /upstream service/i],
    [{ _tag: "Timeout" }, /timed out/i],
    [{ _tag: "UpstreamUnavailable" }, /address, port and network/i],
  ])("gives actionable guidance for %j", async (cause, guidance) => {
    const container = await render(
      <ServerForm
        server={configuredServer}
        onSave={vi.fn()}
        onTestConnection={vi.fn().mockRejectedValue(cause)}
      />,
    );

    await click(byButton(container, m.server_test_connection()));

    expect(container.textContent).toMatch(guidance);
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
    expect(container.textContent).toMatch(/address, port, network and credentials/i);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("primary.example.com");
    expect(rows[1]?.textContent).toContain("backup.example.com");
  });
});

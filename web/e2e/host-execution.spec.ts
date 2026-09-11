import { test, expect, type Page } from "@playwright/test";

const ssh = (host: string, container?: string) => ({
  type: "Server",
  host,
  user: "editor",
  key: { type: "Managed" },
  container,
});
const fixtureHosts = [
  {
    id: "local-container",
    name: "localhost",
    compute: { type: "Local" },
    execution: "container",
  },
  {
    id: "local-host",
    name: "Local host",
    compute: ssh("control-vm"),
    machine: "local",
    execution: "host",
  },
  {
    id: "remote-container",
    name: "Video container",
    compute: ssh("video-vm", "worker"),
    execution: "container",
  },
  {
    id: "remote-host",
    name: "Video host",
    compute: ssh("video-vm"),
    execution: "host",
  },
].map((h) => ({
  ...h,
  state: "Online",
  drained: false,
  reconnecting: false,
  cpus: 2,
  docker: { status: "Unknown" },
  workerVersion: "test",
}));

async function fixture(page: Page) {
  const state = {
    missing: false,
    hosts: [...fixtureHosts],
    launches: [] as Record<string, unknown>[],
    added: [] as Record<string, unknown>[],
    checked: [] as string[],
  };
  await page.addInitScript(() => localStorage.setItem("firetower.token", "test-host-execution"));
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path.endsWith("/readiness")) {
      state.checked.push(path);
      return route.fulfill({
        json: {
          user: "editor",
          checks: [
            {
              name: "Firetower worker",
              available: true,
              required: true,
              detail: "test",
            },
            { name: "Git", available: true, required: true, detail: "git" },
            {
              name: "tmux",
              available: !state.missing,
              required: true,
              detail: state.missing ? "Not installed" : "tmux",
              remedy: "Install tmux on the selected machine.",
            },
            {
              name: "npm",
              available: false,
              required: false,
              detail: "Optional",
            },
          ],
        },
      });
    }
    if (path.endsWith("/hosts/probe"))
      return route.fulfill({ json: { reached: true, diagnosis: null } });
    if (path.endsWith("/hosts")) {
      if (request.method() === "POST") {
        const body = request.postDataJSON();
        state.added.push(body);
        return route.fulfill({
          status: 201,
          json: { ...fixtureHosts[1], ...body, id: "new-host" },
        });
      }
      return route.fulfill({ json: state.hosts });
    }
    if (path.endsWith("/agents"))
      return route.fulfill({
        json: [
          {
            kind: "ClaudeCode",
            label: "Claude Code",
            enabled: true,
            supported: true,
            needsCredential: false,
            credentialSet: false,
            signsInWithACode: false,
            hosts: state.hosts.map((h) => ({
              hostId: h.id,
              installed: true,
              version: "test",
            })),
          },
        ],
      });
    if (path.endsWith("/sessions")) {
      if (request.method() === "POST") {
        state.launches.push(request.postDataJSON());
        // Keep the form open so its payload can be inspected without another page fixture.
        return route.fulfill({
          status: 409,
          json: { code: "NoCapacity", message: "Test captured launch" },
        });
      }
      return route.fulfill({ json: [] });
    }
    if (path.endsWith("/ssh-key"))
      return route.fulfill({
        json: { publicKey: "ssh-ed25519 test", fingerprint: "test" },
      });
    if (path.endsWith("/auth/me"))
      return route.fulfill({
        json: { user: { id: "user", name: "admin", role: "admin" } },
      });
    return route.fulfill({ json: [] });
  });
  return state;
}

async function openLaunch(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "New workspace", exact: true }).first().click();
  await page.getByPlaceholder("auth refactor").fill("Host execution test");
}

test("a host filesystem repository can be connected before choosing its machine", async ({
  page,
}) => {
  await fixture(page);
  let saved: Record<string, unknown> | undefined;
  let probed = false;
  await page.route("**/api/v1/providers", (route) =>
    route.fulfill({
      json: [{ id: "github", label: "GitHub", configured: false, connected: false }],
    }),
  );
  await page.route("**/api/v1/repos/probe", (route) => {
    probed = true;
    return route.fulfill({
      status: 400,
      json: { code: "RepoUnreachable", message: "Not on this machine" },
    });
  });
  await page.route("**/api/v1/repos", (route) => {
    if (route.request().method() !== "POST") return route.fulfill({ json: [] });
    saved = route.request().postDataJSON();
    return route.fulfill({ status: 201, json: { ...saved, id: "r_native", slug: "media-app" } });
  });
  await page.goto("/repos");
  await page.getByRole("button", { name: "+ Connect a repository" }).click();
  await page.getByRole("button", { name: "Paste a URL instead" }).click();
  await page.getByLabel("Repository URL or path").fill("/home/editor/media-app");
  await expect(
    page.getByText("This path will be checked on the machine", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect.poll(() => saved?.remote).toBe("/home/editor/media-app");
  expect(probed).toBe(false);
});

for (const machine of ["local", "remote"] as const) {
  for (const mode of ["container", "host"] as const) {
    test(`launch selects ${mode} execution on the ${machine} machine`, async ({ page }) => {
      const state = await fixture(page);
      await openLaunch(page);
      await page
        .getByLabel("Machine", { exact: true })
        .selectOption(machine === "local" ? "local" : "ssh:video-vm:22");
      await page
        .getByRole("radio", {
          name: mode === "container" ? "Container" : "Directly on host",
          exact: true,
        })
        .check();
      await expect(page.getByRole("region", { name: "Environment readiness" })).toContainText(
        "Runs as editor",
      );
      const launch = page.getByRole("button", { name: /Create workspace/ });
      await expect(launch).toBeEnabled();
      if (machine === "local" && mode === "host") {
        await page.screenshot({ path: test.info().outputPath("native-launch.png") });
      }
      await launch.click();
      await expect.poll(() => state.launches.length).toBe(1);
      expect(state.launches[0].hostId).toBe(`${machine}-${mode}`);
      expect(state.checked).toContain(`/api/v1/hosts/${machine}-${mode}/readiness`);
    });
  }
}

test("missing requirements block launch and rechecking after manual installation enables it", async ({
  page,
}) => {
  const state = await fixture(page);
  state.missing = true;
  await openLaunch(page);
  await page.getByRole("radio", { name: "Directly on host", exact: true }).check();
  const launch = page.getByRole("button", { name: /Create workspace/ });
  await expect(page.getByRole("region", { name: "Environment readiness" })).toContainText(
    "Install tmux on the selected machine",
  );
  await expect(launch).toBeDisabled();
  await page.getByText("Setup instructions", { exact: true }).click();
  await expect(page.getByText("Docker is optional.", { exact: false })).toBeVisible();
  state.missing = false;
  await page.getByRole("button", { name: "Check again", exact: true }).click();
  await expect(launch).toBeEnabled();
  expect(state.launches).toHaveLength(0);
});

test("an unconfigured host environment offers setup without falling back to a container", async ({
  page,
}) => {
  const state = await fixture(page);
  state.hosts = state.hosts.filter((h) => h.id !== "local-host");
  await openLaunch(page);
  await page.getByRole("radio", { name: "Directly on host", exact: true }).check();
  await expect(page.getByRole("button", { name: /Create workspace/ })).toBeDisabled();
  await page.getByRole("button", { name: "Set up an execution environment" }).click();
  await page.getByLabel("Environment name", { exact: true }).fill("Local native");
  await page.getByLabel("SSH address", { exact: true }).fill("control-vm");
  await page.getByLabel("SSH account", { exact: true }).fill("editor");
  await page.getByRole("button", { name: "Check and add" }).click();
  await expect.poll(() => state.added.length).toBe(1);
  expect(state.added[0]).toMatchObject({
    sameMachine: true,
    compute: { type: "Server", host: "control-vm", user: "editor" },
  });
  expect((state.added[0].compute as Record<string, unknown>).container).toBeUndefined();
  expect(state.launches).toHaveLength(0);
});

test("losing the selected environment never switches the launch to another worker", async ({
  page,
}) => {
  const state = await fixture(page);
  state.hosts.push({ ...fixtureHosts[1], id: "local-backup", name: "Backup host connection" });
  await openLaunch(page);
  await page.getByRole("radio", { name: "Directly on host", exact: true }).check();
  await expect(page.getByRole("button", { name: /Create workspace/ })).toBeEnabled();
  state.hosts = state.hosts.filter((h) => h.id !== "local-host");
  await expect(page.getByRole("button", { name: /Create workspace/ })).toBeDisabled({
    timeout: 10000,
  });
  await expect(page.getByRole("radio", { name: "Directly on host", exact: true })).toBeChecked();
  expect(state.launches).toHaveLength(0);
});

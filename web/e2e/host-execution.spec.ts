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
    // Added as a machine of its own, which is what an ssh connection to the
    // box underneath is. It used to be folded into "this server" and shown as
    // that machine's other mode.
    id: "underneath",
    name: "Control VM",
    compute: ssh("control-vm"),
    machine: "local",
    execution: "host",
  },
  {
    id: "remote-host",
    name: "video-vm",
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

type State = {
  missing: boolean;
  noWorker: boolean;
  hosts: Record<string, unknown>[];
  launches: Record<string, unknown>[];
  added: Record<string, unknown>[];
  installed: string[];
  checked: string[];
};

async function fixture(page: Page) {
  const state: State = {
    missing: false,
    noWorker: false,
    hosts: [...fixtureHosts],
    launches: [],
    added: [],
    installed: [],
    checked: [],
  };
  await page.addInitScript(() => localStorage.setItem("firetower.token", "test-host-execution"));
  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path.endsWith("/readiness")) {
      state.checked.push(path);
      if (state.noWorker) {
        return route.fulfill({
          json: {
            checks: [
              {
                name: "Worker connection",
                available: false,
                required: true,
                detail: "The worker is not connected.",
                remedy: "Install the matching firetower-worker binary.",
              },
            ],
          },
        });
      }
      return route.fulfill({
        json: {
          user: "editor",
          checks: [
            { name: "Firetower worker", available: true, required: true, detail: "test" },
            { name: "Git", available: true, required: true, detail: "git" },
            {
              name: "tmux",
              available: !state.missing,
              required: true,
              detail: state.missing ? "Not installed" : "tmux",
              remedy: "sudo apt install tmux",
            },
            { name: "npm", available: false, required: false, detail: "Optional" },
          ],
        },
      });
    }
    if (path.endsWith("/worker") && request.method() === "POST") {
      state.installed.push(path);
      state.noWorker = false;
      return route.fulfill({ json: { version: "test" } });
    }
    if (path.endsWith("/hosts/probe"))
      return route.fulfill({ json: { reached: true, diagnosis: null } });
    if (path.endsWith("/hosts")) {
      if (request.method() === "POST") {
        const body = request.postDataJSON();
        state.added.push(body);
        const made = {
          ...fixtureHosts[2],
          ...body,
          id: `made-${state.added.length}`,
          execution: body.compute?.container ? "container" : "host",
        };
        state.hosts.push(made);
        return route.fulfill({ status: 201, json: made });
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
              hostName: h.name,
              installed: true,
              coveredByToken: true,
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

const machine = (page: Page) => page.getByLabel("Machine", { exact: true });
const mode = (page: Page, which: "Container" | "Directly on host") =>
  page.getByRole("button", { name: which, exact: true });
const launch = (page: Page) => page.getByRole("button", { name: /Create workspace/ });

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

/**
 * The machine hosting Firetower runs agents where the control plane runs. There
 * is no second answer, so there is no choice — and the ssh connection to the
 * machine underneath is its own machine rather than this one's other mode.
 */
test("this server states its one way of running instead of offering two", async ({ page }) => {
  const state = await fixture(page);
  await openLaunch(page);
  await machine(page).selectOption("local");

  await expect(page.getByText("the Firetower container", { exact: true })).toBeVisible();
  await expect(mode(page, "Directly on host")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Add it as a machine/ })).toBeVisible();

  await expect(launch(page)).toBeEnabled();
  await launch(page).click();
  await expect.poll(() => state.launches.length).toBe(1);
  expect(state.launches[0].hostId).toBe("local-container");
});

test("the machine underneath is listed as a machine of its own", async ({ page }) => {
  await fixture(page);
  await openLaunch(page);
  await expect(machine(page).locator("option")).toContainText([
    "This server — alongside Firetower",
    "Control VM · editor@control-vm",
    "video-vm · editor@video-vm",
    "+ Add a machine…",
  ]);
});

for (const which of ["container", "host"] as const) {
  test(`launch selects ${which} execution on a remote machine`, async ({ page }) => {
    const state = await fixture(page);
    await openLaunch(page);
    await machine(page).selectOption("ssh:video-vm:22");
    await mode(page, which === "container" ? "Container" : "Directly on host").click();

    await expect(page.getByText("Ready — runs as editor", { exact: false })).toBeVisible();
    await expect(launch(page)).toBeEnabled();
    await launch(page).click();
    await expect.poll(() => state.launches.length).toBe(1);

    if (which === "host") {
      expect(state.launches[0].hostId).toBe("remote-host");
      expect(state.added).toHaveLength(0);
    } else {
      // Never used on this machine before, so it was made when it was picked —
      // with the connection the machine already has, and no second form.
      expect(state.added).toHaveLength(1);
      expect(state.added[0]).toMatchObject({
        compute: { type: "Server", host: "video-vm", user: "editor", container: "firetower-worker" },
      });
      expect(state.added[0].sameMachine).toBeUndefined();
      expect(state.launches[0].hostId).toBe("made-1");
    }
  });
}

test("what is ready is one line, and what is missing is itemised", async ({ page }) => {
  const state = await fixture(page);
  await openLaunch(page);
  await machine(page).selectOption("ssh:video-vm:22");

  await expect(page.getByText("Ready — runs as editor", { exact: false })).toBeVisible();
  // Not eight rows of things that are fine on a form filled in twenty times a day.
  await expect(page.getByText("4 checks")).toBeVisible();
  await expect(page.getByText("git", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: /4 checks/ }).click();
  await expect(page.getByText("git", { exact: true })).toBeVisible();
  expect(state.launches).toHaveLength(0);
});

test("missing requirements block launch, and the footer says which", async ({ page }) => {
  const state = await fixture(page);
  state.missing = true;
  await openLaunch(page);
  await machine(page).selectOption("ssh:video-vm:22");

  await expect(page.getByText("One thing is missing on editor@video-vm")).toBeVisible();
  await expect(page.getByText("sudo apt install tmux")).toBeVisible();
  // What passed, collapsed into one line rather than listed.
  await expect(page.getByText("Firetower worker, Git — all fine.")).toBeVisible();
  // The disabled button and the sentence beside it now say the same thing.
  await expect(page.getByText("tmux missing above", { exact: false })).toBeVisible();
  await expect(launch(page)).toBeDisabled();

  state.missing = false;
  await page.getByRole("button", { name: "Check again", exact: true }).click();
  await expect(launch(page)).toBeEnabled();
  expect(state.launches).toHaveLength(0);
});

test("a machine with no worker is offered one rather than a build command", async ({ page }) => {
  const state = await fixture(page);
  state.noWorker = true;
  await openLaunch(page);
  await machine(page).selectOption("ssh:video-vm:22");

  await expect(page.getByText("There is no worker on editor@video-vm yet")).toBeVisible();
  await expect(page.getByText("cargo build", { exact: false })).toHaveCount(0);
  await expect(launch(page)).toBeDisabled();

  await page.getByRole("button", { name: "Install the worker" }).click();
  await expect.poll(() => state.installed).toContain("/api/v1/hosts/remote-host/worker");
  await expect(launch(page)).toBeEnabled();
});

test("losing the selected environment never switches the launch to another worker", async ({
  page,
}) => {
  const state = await fixture(page);
  await openLaunch(page);
  await machine(page).selectOption("ssh:video-vm:22");
  await expect(launch(page)).toBeEnabled();

  state.hosts = state.hosts.filter((h) => h.id !== "remote-host");
  await expect(launch(page)).toBeDisabled({ timeout: 10000 });
  expect(state.launches).toHaveLength(0);
});

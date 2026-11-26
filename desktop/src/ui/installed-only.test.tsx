/**
 * What an installed app offers and a served page does not — both ways round.
 *
 * **Every assertion here is a pair, and the pair is the test.** Taking a
 * control away in a browser is easy to get right and easy to overdo, and the
 * way it is overdone is silent: a condition that is wrong in both directions
 * reads as a passing "it is absent in a browser" while the Tauri build has
 * quietly lost the same control. Ticket 06's hardest acceptance criterion is
 * that the installed build behaves *identically* before and after, so each
 * test below renders the same component twice with the one observable flipped
 * and asserts on both answers.
 *
 * The seam is `~/bridge`, which is the only thing `~/installed-app` reads —
 * so what is flipped here is the real observable and everything above it
 * follows, including the keycaps. Nothing stubs the predicate itself.
 *
 * `renderToStaticMarkup` with a seeded cache, as the earlier tickets
 * established: no jsdom, no testing-library, no network.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getMeQueryKey } from "~/api/generated/auth/auth";
import { getGetUpdatesQueryKey, getListRunsQueryKey } from "~/api/generated/updates/updates";
import type { Backend, Fleet } from "~/fleet";
import type { UpdateStatus } from "~/api/generated/model";

/* The shell, stood in for. A live object, so one test can ask the same
   component both questions. */
const shell = vi.hoisted(() => ({
  bridge: {
    native: true,
    setTitle: () => {},
    setBadge: () => {},
    notify: () => {},
    minimize: () => {},
    zoom: () => {},
    close: () => {},
    save: async () => null,
    shoot: async () => null,
    canShoot: async () => false,
    loadArtifact: null,
    secrets: null,
  },
}));
vi.mock("~/bridge", () => shell);

/* The fleet is module state fed by a registry in `localStorage`; the screens
   here only ever read it, so it is handed over rather than hydrated. One
   Firetower, which is what a served page always has — and the point of the
   installed half of each pair is that the *same* fleet still draws the
   switcher, so nothing here is passing because the fleet is empty. */
const HERE: Backend = {
  id: "s_acme",
  org: "Acme",
  user: "kevin",
  mark: "Ac",
  url: "https://acme.example",
  reach: "live",
};
const fleet = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock("~/fleet", async (orig) => ({
  ...(await orig<typeof import("~/fleet")>()),
  useFleet: () => fleet.rows,
}));

/** The registry, which `Account` reads for the address it signed in on. */
vi.mock("~/servers", async (orig) => ({
  ...(await orig<typeof import("~/servers")>()),
  servers: () => [{ serverId: HERE.id, url: HERE.url, org: HERE.org, user: HERE.user, token: "t", addedAt: 0 }],
  forget: () => {},
}));

const STATUS: UpdateStatus = {
  current: "0.58.0",
  updateAvailable: false,
  hosts: [{ hostId: "h_1", name: "studio", online: true, drained: false, sessions: [], upgradable: false, mayUpgrade: false }],
  controlPlane: {
    version: "0.58.0",
    upgradable: true,
    mayUpgrade: true,
    updater: { configured: true, reachable: true },
  },
  channel: {
    channel: "general",
    recognised: true,
    switchable: true,
    pinned: false,
    tag: "general",
    offers: [],
    manifest: { packages: [], url: "https://releases.example/manifest.json" },
  } as unknown as UpdateStatus["channel"],
};

function cache() {
  const c = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnMount: false } } });
  c.setQueryData(getMeQueryKey(), { user: { username: "kevin", role: "admin" }, organization: { name: "Acme" } });
  c.setQueryData(getGetUpdatesQueryKey(), STATUS);
  c.setQueryData(getListRunsQueryKey(), []);
  return c;
}

/**
 * Render something once, with or without a shell around it.
 *
 * The modules are reset and re-imported per render because `~/installed-app`
 * is read during the render and `platform.ts` resolves the platform at
 * import — so a pair has to be two imports, not two calls.
 */
async function draw(
  installed: boolean,
  what: (m: {
    Titlebar: typeof import("~/ui/Titlebar").Titlebar;
    Profile: typeof import("~/ui/ProfileMenu").Profile;
    ProfileMenu: typeof import("~/ui/ProfileMenu").ProfileMenu;
    Account: typeof import("~/ui/Account").Account;
    Updates: typeof import("~/ui/Updates").Updates;
  }) => React.ReactElement,
  { platform = "MacIntel", here = HERE }: { platform?: string; here?: Backend } = {},
): Promise<string> {
  vi.resetModules();
  vi.stubGlobal("navigator", { platform });
  vi.stubGlobal("window", {
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    location: { hash: "#/", search: "", origin: "https://acme.example", protocol: "https:" },
    history: { pushState: () => {}, replaceState: () => {}, back: () => {}, forward: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: () => 0,
  });
  shell.bridge.native = installed;
  fleet.rows = [{ backend: here, sessions: [], error: null } satisfies Fleet];
  const [titlebar, menu, account, updates] = await Promise.all([
    import("~/ui/Titlebar"),
    import("~/ui/ProfileMenu"),
    import("~/ui/Account"),
    import("~/ui/Updates"),
  ]);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache()}>
      {what({
        Titlebar: titlebar.Titlebar,
        Profile: menu.Profile,
        ProfileMenu: menu.ProfileMenu,
        Account: account.Account,
        Updates: updates.Updates,
      })}
    </QueryClientProvider>,
  );
}

/** Both answers for one rendering, so every assertion below is a pair. */
async function both(
  what: Parameters<typeof draw>[1],
  opts?: Parameters<typeof draw>[2],
): Promise<{ app: string; tab: string }> {
  return { app: await draw(true, what, opts), tab: await draw(false, what, opts) };
}

const titlebar = () => both((m) => <m.Titlebar serverId={HERE.id} onSwitch={() => {}} />);
const profile = (elsewhere = false) =>
  both((m) => (
    <m.Profile
      backend={HERE}
      who="kevin"
      elsewhere={elsewhere}
      updates={{ label: "Updates", dot: false }}
      onSwitch={() => {}}
      onClose={() => {}}
      onForgot={() => {}}
    />
  ));

beforeEach(() => {
  shell.bridge.native = true;
});

describe("switching between Firetowers", () => {
  it("is the profile menu's second page, and its door is gone in a browser", async () => {
    const { app, tab } = await profile();
    expect(app).toContain("Switch Firetower");
    expect(app).toContain("In Acme");
    expect(tab).not.toContain("Switch Firetower");
    expect(tab).not.toContain("In Acme");
  });

  it("takes the menu's server mark with it", async () => {
    const { app, tab } = await profile();
    expect(app).toContain("server-mark");
    expect(tab).not.toContain("server-mark");
  });

  /* The rest of the menu is untouched: the point is that one row went, not
     that the menu did. Checked in the browser render, because that is the one
     a mistake here would empty. */
  it("leaves everything else in the menu alone", async () => {
    const { tab } = await profile();
    for (const row of ["Account", "Settings", "Updates", "Appearance", "Sign out of Acme"]) {
      expect(tab).toContain(row);
    }
  });

  it("takes the title bar's mark but keeps org / user as text", async () => {
    const { app, tab } = await titlebar();
    expect(app).toContain("server-mark");
    expect(app).toContain("Switch Firetower");
    expect(tab).not.toContain("server-mark");
    expect(tab).not.toContain("Switch Firetower");
    // The sentence the bar exists for survives in both.
    for (const html of [app, tab]) {
      expect(html).toContain("Acme");
      expect(html).toContain("kevin");
    }
  });

  it("takes the avatar's ember dot, because there is no elsewhere to be waited on in", async () => {
    const avatar = () =>
      both((m) => <m.ProfileMenu backend={HERE} waitingElsewhere onSwitch={() => {}} onForgot={() => {}} />);
    const { app, tab } = await avatar();
    expect(app).toContain("bg-ember");
    expect(app).toContain("someone is waiting elsewhere");
    expect(tab).not.toContain("bg-ember");
    expect(tab).not.toContain("someone is waiting elsewhere");
  });

  it("takes Forget off the account screen and leaves Sign out", async () => {
    const { app, tab } = await both((m) => <m.Account backend={HERE} onForgot={() => {}} />);
    expect(app).toContain("Forget this Firetower");
    expect(tab).not.toContain("Forget this Firetower");
    for (const html of [app, tab]) expect(html).toContain("Sign out");
  });
});

describe("what only a window can do", () => {
  /* The traffic-light gutter, which needs a shell *and* a Mac — the two
     questions `~/installed-app` and `platform.ts` answer separately, read
     side by side at one call site. */
  it("reserves the traffic lights' gutter only inside the app", async () => {
    const { app, tab } = await titlebar();
    expect(app).toContain("var(--chrome-lights)");
    expect(tab).not.toContain("var(--chrome-lights)");
  });

  /* Off a Mac the window has no frame and draws its own buttons. Pinned to
     Windows rather than inherited from whatever machine the suite runs on,
     because the assertion is about the shell and not about the platform. */
  it("draws the window's own buttons off a Mac, and never in a browser", async () => {
    const { app, tab } = await both((m) => <m.Titlebar serverId={HERE.id} onSwitch={() => {}} />, { platform: "Win32" });
    for (const control of ["Minimize", "Maximize", "Close"]) expect(app).toContain(control);
    for (const control of ["Minimize", "Maximize", "Close"]) expect(tab).not.toContain(control);
  });

  it("answers nothing from a drag region in a browser", async () => {
    const press = async (installed: boolean) => {
      vi.resetModules();
      shell.bridge.native = installed;
      const { drag } = await import("~/drag");
      let stopped = false;
      drag.onMouseDown({
        button: 0,
        preventDefault: () => void (stopped = true),
        target: { closest: () => null },
      } as unknown as React.MouseEvent<HTMLElement>);
      return stopped;
    };
    // The window is ours: the press starts a drag and stops the text cursor.
    expect(await press(true)).toBe(true);
    // The window is the browser's: the press is left alone entirely.
    expect(await press(false)).toBe(false);
  });
});

describe("the app updating itself", () => {
  it("draws This app only where there is an app to update", async () => {
    const { app, tab } = await both((m) => <m.Updates />);
    expect(app).toContain("This app");
    expect(tab).not.toContain("This app");
  });

  /* The half of that screen the ticket is explicit about keeping: it is about
     the control plane and the machines, which a browser is as entitled to as
     a window. */
  it("keeps the control plane and the machines either way", async () => {
    const { app, tab } = await both((m) => <m.Updates />);
    for (const html of [app, tab]) {
      expect(html).toContain("This Firetower");
      expect(html).toContain("Machines");
      expect(html).toContain("studio");
      expect(html).toContain("Check again");
    }
  });
});

describe("the shortcuts", () => {
  it("advertises none of the window's keys in a browser", async () => {
    const { app, tab } = await titlebar();
    expect(app).toContain("Hide the panel  ⌘\\");
    expect(tab).toContain("Hide the panel");
    expect(tab).not.toContain("⌘\\");
  });

  it("takes ⌘, off the Settings row and leaves the row", async () => {
    const { app, tab } = await profile();
    expect(app).toContain("⌘,");
    expect(tab).not.toContain("⌘,");
    expect(tab).toContain("Settings");
  });
});

describe("what must not change", () => {
  /* Dimmed, never red, and never gone. One control plane can still be out of
     reach — a VPN that is off is the case the memo predicts — and that rule
     was about reachability rather than about having several, so replacing the
     bar's button with text must not have taken the dark case with it. */
  it("still draws a Firetower that cannot be reached, in both clients", async () => {
    const dark: Backend = { ...HERE, reach: "unreachable" };
    const { app, tab } = await both((m) => <m.Titlebar serverId={dark.id} onSwitch={() => {}} />, { here: dark });
    for (const html of [app, tab]) {
      expect(html).toContain("Acme");
      expect(html).toContain("kevin");
      expect(html).not.toContain("brick");
    }
    // The mark the installed build keeps says so in the one allowed way.
    expect(app).toContain('data-reach="unreachable"');
  });

  /* `platform.ts` decides what a modifier is *called* and is untouched by any
     of this — which is only visible off a Mac, where the window's modifier is
     Ctrl and is written out. The pair is the point: the name is the
     platform's, and whether there is a shortcut at all is this ticket's. */
  it("leaves the modifier's name to the platform", async () => {
    const { app, tab } = await both((m) => <m.Titlebar serverId={HERE.id} onSwitch={() => {}} />, { platform: "Win32" });
    expect(app).toContain("Ctrl+\\");
    expect(tab).not.toContain("Ctrl+");
  });
});

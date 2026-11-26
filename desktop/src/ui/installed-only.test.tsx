/**
 * What an installed app offers and a served page does not — both ways round,
 * for **every** module that asks the question.
 *
 * **Every assertion here is a pair, and the pair is the test.** Taking a
 * control away in a browser is easy to get right and easy to overdo, and the
 * way it is overdone is silent: a condition that is wrong in both directions
 * reads as a passing "it is absent in a browser" while the Tauri build has
 * quietly lost the same control. Ticket 06's hardest acceptance criterion is
 * that the installed build behaves *identically*, so each test renders or
 * calls the same thing twice with the one observable flipped.
 *
 * The seam is `~/bridge`, which is the only thing `~/installed-app` reads — so
 * what is flipped is the real observable and everything above it follows,
 * keycaps included. Nothing stubs the predicate itself.
 *
 * ## The first version of this covered five of fourteen, and nothing said so
 *
 * That is the defect this file's own shape now exists to prevent, and it is
 * not hypothetical: it is the third time on this branch that something passed
 * while asserting nothing — the cache rule that ran without a bundle, the
 * collision guard that asked a narrower question than the router, and this.
 * So `COVERED` below is checked against the source, the way
 * `destinations.test.ts` checks its two pane tables against each other: a
 * fifteenth module that reads `~/installed-app` and is not listed here fails
 * this file, and a listed module that stops reading it fails too.
 *
 * **Four gates cannot be reached by `renderToStaticMarkup` at all** — they sit
 * inside a `useEffect` or inside xterm's key handler, and effects do not run
 * in a static render. Each of those exports its decision as a pure function
 * instead, the way `Inspector.tsx` exports `tabsFor` and `shownTab` for
 * `inspector-tabs.test.ts`, and the function is asserted here. The handlers
 * call them; they do not re-implement them.
 *
 * `renderToStaticMarkup` with a seeded cache, as the earlier tickets
 * established: no jsdom, no testing-library, no network.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getMeQueryKey } from "~/api/generated/auth/auth";
import { getListSessionsQueryKey } from "~/api/generated/sessions/sessions";
import { getGetUpdatesQueryKey, getListRunsQueryKey } from "~/api/generated/updates/updates";
import type { Backend, Fleet } from "~/fleet";
import type { UpdateStatus } from "~/api/generated/model";

/* The shell, stood in for. A live object, so one test can ask the same thing
   both questions. */
const shell = vi.hoisted(() => ({
  bridge: {
    native: true,
    setTitle: () => {},
    setBadge: vi.fn(),
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

/* The shell's own API, so `update-shell.ts`'s installed branch can be seen
   reaching for it rather than only its browser branch returning early. Both
   halves matter: "asks nothing" means something only beside "asks". */
const tauri = vi.hoisted(() => ({ invoke: vi.fn(), getVersion: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => tauri.invoke(...a) }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: () => tauri.getVersion() }));

/* The fleet is module state fed by a registry in `localStorage`; the screens
   here only ever read it, so it is handed over rather than hydrated. One
   Firetower, which is what a served page always has — and the installed half
   of each pair draws the switcher from that *same* fleet, so nothing here
   passes because the fleet is empty. */
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
  c.setQueryData(getListSessionsQueryKey(undefined), []);
  return c;
}

/** Enough of a window for the navigation shim and the preferences. */
function stubWindow() {
  vi.stubGlobal("window", {
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    location: { hash: "#/", search: "", origin: "https://acme.example", protocol: "https:" },
    history: { pushState: () => {}, replaceState: () => {}, back: () => {}, forward: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: () => 0,
    innerWidth: 1440,
  });
}

type Parts = {
  Titlebar: typeof import("~/ui/Titlebar").Titlebar;
  Profile: typeof import("~/ui/ProfileMenu").Profile;
  ProfileMenu: typeof import("~/ui/ProfileMenu").ProfileMenu;
  Account: typeof import("~/ui/Account").Account;
  Updates: typeof import("~/ui/Updates").Updates;
  Rail: typeof import("~/ui/Rail").Rail;
  Palette: typeof import("~/ui/Palette").Palette;
  Resize: typeof import("~/ui/Resize").Resize;
  StartProvider: typeof import("~/start").StartProvider;
};

/**
 * Render something once, with or without a shell around it.
 *
 * The modules are reset and re-imported per render because `~/installed-app`
 * is read during the render and `platform.ts` resolves the platform at
 * import — so a pair has to be two imports, not two calls.
 */
async function draw(
  installed: boolean,
  what: (m: Parts) => React.ReactElement,
  { platform = "MacIntel", here = HERE }: { platform?: string; here?: Backend } = {},
): Promise<string> {
  vi.resetModules();
  vi.stubGlobal("navigator", { platform });
  stubWindow();
  shell.bridge.native = installed;
  fleet.rows = [{ backend: here, sessions: [], error: null } satisfies Fleet];
  const [titlebar, menu, account, updates, rail, palette, resize, start] = await Promise.all([
    import("~/ui/Titlebar"),
    import("~/ui/ProfileMenu"),
    import("~/ui/Account"),
    import("~/ui/Updates"),
    import("~/ui/Rail"),
    import("~/ui/Palette"),
    import("~/ui/Resize"),
    import("~/start"),
  ]);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache()}>
      {what({
        Titlebar: titlebar.Titlebar,
        Profile: menu.Profile,
        ProfileMenu: menu.ProfileMenu,
        Account: account.Account,
        Updates: updates.Updates,
        Rail: rail.Rail,
        Palette: palette.Palette,
        Resize: resize.Resize,
        StartProvider: start.StartProvider,
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

/** The same, for a module asked directly rather than rendered. */
async function bothOf<T>(ask: () => Promise<T> | T): Promise<{ app: T; tab: T }> {
  const run = async (installed: boolean) => {
    vi.resetModules();
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    stubWindow();
    shell.bridge.native = installed;
    tauri.invoke.mockReset().mockResolvedValue(null);
    tauri.getVersion.mockReset().mockResolvedValue("0.58.0");
    shell.bridge.setBadge.mockReset();
    return ask();
  };
  return { app: await run(true), tab: await run(false) };
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
const rail = () =>
  both((m) => (
    <m.StartProvider>
      <m.Rail backend={HERE} onSwitch={() => {}} onForgot={() => {}} />
    </m.StartProvider>
  ));

beforeEach(() => {
  shell.bridge.native = true;
});

/* ── The list that cannot be fallen out of ─────────────────────────────── */

/**
 * Every module that asks the question, and how this file answers for it.
 *
 * `rendered` — drawn twice by `renderToStaticMarkup`, asserted on both.
 * `called` — a module function invoked twice, with the bridge flipped.
 * `rule` — the gate lives in an effect or in xterm's key handler, which a
 * static render cannot reach, so the module exports its decision as a pure
 * function and that is asserted instead. Named per module rather than left to
 * be inferred, because *how* a thing is covered is the part that rots.
 *
 * `but` says what is **not** reached, where something is not. One module has
 * one, and writing it down is the point: a gap nobody can see is the defect
 * this table exists to stop, so the gaps are in the table rather than absent
 * from it.
 */
const COVERED: Record<string, { how: "rendered" | "called" | "rule"; by: string; but?: string }> = {
  "src/App.tsx": { how: "rule", by: "dockBadge — the gate is inside a useEffect" },
  "src/drag.ts": { how: "called", by: "drag.onMouseDown, which is a plain object's handler" },
  "src/update-shell.ts": { how: "called", by: "check, version and install, against a mocked shell API" },
  "src/update.ts": { how: "called", by: "look, then currentBuild" },
  "src/ui/Account.tsx": { how: "rendered", by: "the Forget control" },
  "src/ui/Palette.tsx": { how: "rendered", by: "the keycaps; commands() for the Connect entry, which is past the nine drawn at rest" },
  "src/ui/ProfileMenu.tsx": { how: "rendered", by: "the avatar, and Profile for the switch row" },
  "src/ui/Rail.tsx": { how: "rendered", by: "the destinations' keycaps; railKey for the handler" },
  "src/ui/RailPanel.tsx": { how: "rendered", by: "drawn by Rail, which is pinned by default" },
  "src/ui/Resize.tsx": { how: "rendered", by: "the window's own resize strips" },
  "src/ui/Shell.tsx": { how: "rule", by: "terminalKey — the gate is inside xterm's key handler" },
  "src/ui/Titlebar.tsx": { how: "rendered", by: "the mark, the gutter and the window's buttons" },
  "src/ui/Updates.tsx": { how: "rendered", by: "the This app section" },
  "src/ui/Workbench.tsx": {
    how: "rule",
    by: "workbenchKey — the gate is inside a useEffect",
    /* **Measured, not assumed.** `Workbench` cannot be reached by
       `renderToStaticMarkup`: it needs the socket provider, and its subtree
       calls `useSyncExternalStore` with no server snapshot in six places —
       `workspace/outbox.ts`, `overlay.ts`, `layout.ts`, `api/conversation.ts`,
       `api/notes.ts`, `api/checkouts.ts` — which React refuses outright. So
       the three keycaps it draws (⌘W in a tab's menu, ⌘J on the terminal
       button and in the shell's header, ⌘\ on *Show the rail*) are covered by
       `advertisedKey`'s own pair in `installed-app.test.ts` and by the four
       components that do render, not here. Giving them a render would mean
       server snapshots on six stores, which is a change to shipped code for a
       test's benefit. */
    but: "its three keycaps are not render-covered; only the handler's rule is",
  },
};

describe("the list of gated modules", () => {
  /* The same walk `components/ui/reuse.test.ts` does, and for the same
     reason: the question is about imports rather than pixels, and a check
     that runs in two seconds is one people keep. `fileURLToPath` rather than
     `.pathname`, and posix separators, because both have broken a Windows
     runner in this repository before. */
  const ROOT = fileURLToPath(new URL("../", import.meta.url));
  const asking: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "generated") walk(path);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        if (/from "~\/installed-app"/.test(readFileSync(path, "utf8"))) {
          asking.push(`src/${path.slice(ROOT.length).split(sep).join("/")}`);
        }
      }
    }
  };
  walk(ROOT);

  /**
   * **The ratchet.** The first version of this file covered five of fourteen
   * and nothing failed, because what a test file covers is invisible to every
   * other test. This makes it visible: add a fifteenth gate without a row
   * here and this fails on the next run, and take a gate away without
   * removing its row and it fails too.
   */
  it("is exactly the modules that read the predicate", () => {
    expect(asking.sort()).toEqual(Object.keys(COVERED).sort());
  });

  it("says how each one is covered, so the answer cannot be none", () => {
    for (const [module, { how, by }] of Object.entries(COVERED)) {
      expect(by, `${module} has no note saying how it is covered`).not.toBe("");
      expect(["rendered", "called", "rule"]).toContain(how);
    }
  });

  /* The gaps, counted. One, and it is named — which is the difference between
     a documented limit and an oversight. */
  it("has exactly one module with something it does not reach", () => {
    const gaps = Object.entries(COVERED).filter(([, c]) => c.but);
    expect(gaps.map(([m]) => m)).toEqual(["src/ui/Workbench.tsx"]);
  });
});

/* ── 1 · Multi-installation switching ──────────────────────────────────── */

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
    const { app, tab } = await both((m) => (
      <m.ProfileMenu backend={HERE} waitingElsewhere onSwitch={() => {}} onForgot={() => {}} />
    ));
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

  /* The palette is still openable in a browser — the panel's Search glyph
     fires the same event ⌘K did — so it was the one place left that still
     offered to go and find another Firetower.

     Asked of `commands()` rather than of the rendered list, and that is not a
     shortcut: the palette draws nine rows until somebody types and this entry
     is the thirteenth, so a render could never have seen it either way. */
  it("takes the palette's Connect command and leaves every address in this one", async () => {
    const offered = await bothOf(async () => {
      const { commands } = await import("~/ui/Palette");
      return commands().map((c) => c.id);
    });
    expect(offered.app).toContain("c:connect");
    expect(offered.tab).not.toContain("c:connect");
    for (const list of [offered.app, offered.tab]) {
      for (const id of ["c:home", "c:tasks", "c:organisation", "c:new", "c:settings", "c:account", "c:updates"]) {
        expect(list).toContain(id);
      }
    }
  });
});

/* ── 2 · What only a window can do ─────────────────────────────────────── */

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

  /* The strips that resize a frameless window. Windows for the same reason as
     above: on a Mac the platform draws its own margin and these are never
     there, which would make the browser half pass for the wrong reason. */
  it("draws the resize strips only around a window that is ours", async () => {
    const { app, tab } = await both((m) => <m.Resize />, { platform: "Win32" });
    expect(app).toContain('data-resize="South"');
    expect(tab).not.toContain("data-resize");
  });

  it("answers nothing from a drag region in a browser", async () => {
    const pressed = await bothOf(async () => {
      const { drag } = await import("~/drag");
      let stopped = false;
      drag.onMouseDown({
        button: 0,
        preventDefault: () => void (stopped = true),
        target: { closest: () => null },
      } as unknown as React.MouseEvent<HTMLElement>);
      return stopped;
    });
    // The window is ours: the press starts a drag and stops the text cursor.
    expect(pressed.app).toBe(true);
    // The window is the browser's: the press is left alone entirely.
    expect(pressed.tab).toBe(false);
  });

  /**
   * The dock, through the rule the effect calls.
   *
   * `bridge.setBadge` is already a no-op in a browser, so this gate changes
   * nothing visible — it is the call site F4 deletes. Three answers, and the
   * third is the point: `null` means *take the badge off*, `undefined` means
   * *say nothing at all*, and collapsing them would put the gate back.
   */
  it("tells the dock a count, a clear, or nothing at all", async () => {
    const { dockBadge } = await import("~/App");
    expect(dockBadge(3, true)).toBe(3);
    expect(dockBadge(0, true)).toBe(null);
    expect(dockBadge(3, false)).toBe(undefined);
    expect(dockBadge(0, false)).toBe(undefined);
  });
});

/* ── 3 · The app updating itself ───────────────────────────────────────── */

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

  /* The shell's half of the update path, asked outright. "Asks nothing" means
     something only beside "asks": the installed answer has to reach the
     shell's own API, or a browser returning null would pass against a module
     that had stopped working altogether. */
  it("asks the shell for a release only where there is a build to move", async () => {
    const asked = await bothOf(async () => {
      const { check } = await import("~/update-shell");
      const answer = await check(null);
      return { answer, invoked: tauri.invoke.mock.calls.map((c) => c[0]) };
    });
    expect(asked.app.invoked).toContain("update_check");
    expect(asked.tab.invoked).toEqual([]);
    expect(asked.tab.answer).toBeNull();
  });

  it("says which build this is only where there is one", async () => {
    const said = await bothOf(async () => {
      const { version } = await import("~/update-shell");
      return version();
    });
    expect(said.app).toBe("0.58.0");
    expect(said.tab).toBeNull();
  });

  it("refuses an install in a browser rather than reaching for a shell", async () => {
    const tried = await bothOf(async () => {
      const { install } = await import("~/update-shell");
      return install().then(
        () => "installed" as const,
        (e: Error) => e.message,
      );
    });
    expect(tried.app).toBe("installed");
    expect(tried.tab).toBe("There is nothing to install — check again.");
  });

  /* And the watch above it, which is what would light the avatar's `.news`
     mark for this app's own build. In a browser it never finds anything,
     which is what leaves that mark to the deployment alone. */
  it("never finds a newer build of itself in a browser", async () => {
    const found = await bothOf(async () => {
      tauri.invoke.mockResolvedValue({ version: "0.59.0", currentVersion: "0.58.0", notes: null, channel: null });
      const { look, currentBuild } = await import("~/update");
      await look();
      return currentBuild().newer;
    });
    expect(found.app).toBe("0.59.0");
    expect(found.tab).toBeNull();
  });
});

/* ── 4 · The shortcuts ─────────────────────────────────────────────────── */

describe("the shortcuts, where they are drawn", () => {
  it("advertises none of the window's keys in the title bar", async () => {
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

  /* The rail's eight numbers, and the panel beside it — which is pinned by
     default, so one render reaches both. `STYLE.md`'s fifth rule is that the
     window says what it can do, and a keycap naming a key nothing listens for
     is that rule inverted. */
  it("takes ⌘1–⌘8 off the rail and leaves every icon", async () => {
    const { app, tab } = await rail();
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) expect(app).toContain(`⌘${n}`);
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) expect(tab).not.toContain(`⌘${n}`);
    for (const html of [app, tab]) {
      for (const label of ["Dashboard", "Tasks", "Artifacts", "Organisation"]) {
        expect(html).toContain(`aria-label="${label}"`);
      }
    }
  });

  it("takes ⌘N, ⌘K and ⌘\\ off the panel and leaves the row and the glyphs", async () => {
    const { app, tab } = await rail();
    for (const k of ["⌘N", "⌘K", "⌘\\"]) expect(app).toContain(k);
    for (const k of ["⌘N", "⌘K", "⌘\\"]) expect(tab).not.toContain(k);
    for (const html of [app, tab]) {
      expect(html).toContain("New workspace");
      expect(html).toContain("Find anything");
      expect(html).toContain("Hide this panel");
    }
  });

  it("takes the keycaps out of the palette and leaves its commands", async () => {
    const { app, tab } = await both((m) => <m.Palette open onClose={() => {}} />);
    expect(app).toContain("⌘1");
    expect(app).toContain("⌘N");
    expect(tab).not.toContain("⌘");
    expect(tab).toContain("New workspace");
  });
});

/**
 * The shortcuts, where they are *listened for*.
 *
 * Three handlers, none of which a static render can reach — they are built
 * inside a `useEffect` or inside xterm's key handler. Each exports its
 * decision; the handler calls it and does the `preventDefault` for whatever
 * it claims, so a key this answers `null` for is a key nothing prevents.
 */
describe("the shortcuts, where they are listened for", () => {
  const chord = (key: string) => ({ key, metaKey: true, ctrlKey: false, altKey: false });
  const local = (key: string) => ({ key, metaKey: false, ctrlKey: true, altKey: false });
  const where = (installed: boolean) => ({ installed, inTerminal: () => false, path: "/" });

  it("the rail claims its eight numbers inside the app and nothing in a browser", async () => {
    const { railKey } = await import("~/ui/Rail");
    expect(railKey(chord("8"), where(true))).toEqual({ at: "go", href: "/configuration/people" });
    expect(railKey(chord("1"), where(true))).toEqual({ at: "go", href: "/" });
    expect(railKey(chord("8"), where(false))).toBeNull();
    expect(railKey(chord("1"), where(false))).toBeNull();
  });

  it("and ⌘, ⌘K ⌘N ⌘\\ with them", async () => {
    const { railKey } = await import("~/ui/Rail");
    const { SETTINGS_HOME } = await import("~/ui/config/panes");
    expect(railKey(chord(","), where(true))).toEqual({ at: "go", href: SETTINGS_HOME });
    expect(railKey(chord("k"), where(true))).toEqual({ at: "palette" });
    expect(railKey(chord("n"), where(true))).toEqual({ at: "new" });
    expect(railKey(chord("\\"), where(true))).toEqual({ at: "panel" });
    for (const k of [",", "k", "n", "\\"]) expect(railKey(chord(k), where(false))).toBeNull();
  });

  /* Transcribed, not reshaped: the three conditions that already refused a
     keystroke inside the app still refuse it. */
  it("still refuses what it always refused inside the app", async () => {
    const { railKey } = await import("~/ui/Rail");
    // Not the window's modifier.
    expect(railKey(local("8"), where(true))).toBeNull();
    // A focused terminal owns the keyboard.
    expect(railKey(chord("8"), { installed: true, inTerminal: () => true, path: "/" })).toBeNull();
    // The workbench owns the backslash inside a workspace.
    expect(railKey(chord("\\"), { installed: true, inTerminal: () => false, path: "/sessions/s_1" })).toBeNull();
    // And a chord nothing binds is nobody's.
    expect(railKey(chord("z"), where(true))).toBeNull();
  });

  it("the workbench keeps ⌃1–⌃3 in both clients and loses ⌘\\ ⌘J ⌘W in a browser", async () => {
    const { workbenchKey } = await import("~/ui/Workbench");
    const at = (installed: boolean) => ({ installed, inTerminal: false, mayAct: true });
    /* **The local modifier is not what was being argued about.** No browser
       claims Ctrl with a digit on a Mac, so the inspector's tabs are as real
       on a served page as in the window. */
    for (const installed of [true, false]) {
      expect(workbenchKey(local("1"), at(installed))).toEqual({ at: "side", side: "diff" });
      expect(workbenchKey(local("2"), at(installed))).toEqual({ at: "side", side: "files" });
      expect(workbenchKey(local("3"), at(installed))).toEqual({ at: "side", side: "ship" });
    }
    expect(workbenchKey(chord("\\"), at(true))).toEqual({ at: "panel" });
    expect(workbenchKey(chord("j"), at(true))).toEqual({ at: "terminal" });
    expect(workbenchKey(chord("w"), at(true))).toEqual({ at: "close" });
    for (const k of ["\\", "j", "w"]) expect(workbenchKey(chord(k), at(false))).toBeNull();
  });

  it("still refuses what the workbench always refused", async () => {
    const { workbenchKey } = await import("~/ui/Workbench");
    // The Commit panel is not a viewer's; neither is the shortcut to it.
    expect(workbenchKey(local("3"), { installed: true, inTerminal: false, mayAct: false })).toBeNull();
    // A focused terminal owns everything but ⌘J, which is about the panel.
    expect(workbenchKey(chord("\\"), { installed: true, inTerminal: true, mayAct: true })).toBeNull();
    expect(workbenchKey(chord("j"), { installed: true, inTerminal: true, mayAct: true })).toEqual({ at: "terminal" });
    expect(workbenchKey(local("1"), { installed: true, inTerminal: true, mayAct: true })).toBeNull();
  });

  /* The one shortcut a served page keeps, and the one removal with no button
     behind it — the door there is the one every terminal has, `clear`. */
  it("the terminal keeps ⌘F in both and loses ⌘K in a browser", async () => {
    const { terminalKey } = await import("~/ui/Shell");
    expect(terminalKey("f", true)).toBe("find");
    expect(terminalKey("f", false)).toBe("find");
    expect(terminalKey("k", true)).toBe("clear");
    expect(terminalKey("k", false)).toBeNull();
    // Copy and paste are the browser's before they are anybody's.
    for (const installed of [true, false]) {
      expect(terminalKey("c", installed)).toBeNull();
      expect(terminalKey("v", installed)).toBeNull();
    }
  });
});

/* ── What must not change ──────────────────────────────────────────────── */

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

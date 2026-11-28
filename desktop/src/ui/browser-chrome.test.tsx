/**
 * The two pieces of window chrome a browser tab should never have been shown,
 * and the control that had to move before the second could go.
 *
 * `installed-only.test.tsx` holds the ratchet and the pair for every gated
 * module; this holds the three things that are specific to the bar's removal
 * and would otherwise have no home:
 *
 * 1. **No row and no space.** Not an emptied bar — `Titlebar` drawing an empty
 *    `div` would still be `h-(--chrome-title)` of grey across the top of every
 *    screen, which is the defect exactly as it was reported. The assertion is
 *    the absence of the height, not the absence of the text.
 * 2. **Both of `App.tsx`'s call sites**, the bootstrap window as well as the
 *    main one. The gate is inside the component so that neither has to ask,
 *    and that is the claim: `Starting` is the easy one to forget, because it
 *    is only on screen while a keychain answers.
 * 3. **The toggle has a home in both states.** Deleting the bar takes the only
 *    pointer-driven way to pin the panel with it unless the panel's own head
 *    carries both directions, so an unpinned panel is reachable by `⌘\` and by
 *    nothing else in a window and by nothing at all in a tab.
 *
 * `renderToStaticMarkup` with a seeded cache, as the rest of `ui/` does: no
 * jsdom, no testing-library, no network. The seam is `~/bridge`, which is the
 * only thing `~/installed-app` reads, so what is flipped is the real
 * observable rather than the predicate.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getMeQueryKey } from "~/api/generated/auth/auth";
import { getListSessionsQueryKey } from "~/api/generated/sessions/sessions";
import { getGetUpdatesQueryKey, getListRunsQueryKey } from "~/api/generated/updates/updates";
import type { Backend, Fleet } from "~/fleet";

/* The shell, stood in for — a live object, so one test can ask both. */
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

vi.mock("~/servers", async (orig) => ({
  ...(await orig<typeof import("~/servers")>()),
  servers: () => [{ serverId: HERE.id, url: HERE.url, org: HERE.org, user: HERE.user, token: "t", addedAt: 0 }],
}));

function cache() {
  const c = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnMount: false } } });
  c.setQueryData(getMeQueryKey(), { user: { username: "kevin", slug: "kevin", role: "admin" }, organization: { name: "Acme" } });
  c.setQueryData(getListSessionsQueryKey(undefined), []);
  c.setQueryData(getListRunsQueryKey(), []);
  c.setQueryData(getGetUpdatesQueryKey(), { current: "0.58.0", updateAvailable: false, hosts: [] });
  return c;
}

/**
 * Enough of a window for the navigation shim and the preferences.
 *
 * `panel` is the one that earns its keep here: `~/ui/panel` reads the pinned
 * answer out of `localStorage` at module load, before React renders, so the
 * collapsed panel is set up by handing back the stored shape rather than by
 * clicking anything.
 */
function stubWindow({ hash = "#/", panel = null }: { hash?: string; panel?: string | null } = {}) {
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => (k === "firetower.panel" ? panel : null),
      setItem: () => {},
      removeItem: () => {},
    },
    location: { hash, search: "", origin: "https://acme.example", protocol: "https:" },
    history: { pushState: () => {}, replaceState: () => {}, back: () => {}, forward: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout: () => 0,
    innerWidth: 1440,
  });
}

type Parts = {
  Titlebar: typeof import("~/ui/Titlebar").Titlebar;
  Rail: typeof import("~/ui/Rail").Rail;
  RailPanel: typeof import("~/ui/RailPanel").RailPanel;
  StartProvider: typeof import("~/start").StartProvider;
};

/**
 * Render once, with or without a shell around it.
 *
 * Re-imported per render because `~/installed-app` is read during the render
 * and `platform.ts` resolves the platform at import, so a pair has to be two
 * imports rather than two calls.
 */
async function draw(
  installed: boolean,
  what: (m: Parts) => React.ReactElement,
  { hash = "#/", panel = null }: { hash?: string; panel?: string | null } = {},
): Promise<string> {
  vi.resetModules();
  vi.stubGlobal("navigator", { platform: "MacIntel" });
  stubWindow({ hash, panel });
  shell.bridge.native = installed;
  fleet.rows = [{ backend: HERE, sessions: [], error: null } satisfies Fleet];
  const [titlebar, rail, railPanel, start] = await Promise.all([
    import("~/ui/Titlebar"),
    import("~/ui/Rail"),
    import("~/ui/RailPanel"),
    import("~/start"),
  ]);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache()}>
      {what({
        Titlebar: titlebar.Titlebar,
        Rail: rail.Rail,
        RailPanel: railPanel.RailPanel,
        StartProvider: start.StartProvider,
      })}
    </QueryClientProvider>,
  );
}

const both = async (what: Parameters<typeof draw>[1], opts?: Parameters<typeof draw>[2]) => ({
  app: await draw(true, what, opts),
  tab: await draw(false, what, opts),
});

beforeEach(() => {
  shell.bridge.native = true;
});

/* ── 1 · The strip of grey across the top ─────────────────────────────── */

describe("the title bar, in a browser", () => {
  /**
   * **The height is the assertion, not the text.**
   *
   * What was reported was not "the bar says the wrong thing" — it was a dead
   * strip across the whole top of the page, about 110px of it on the screen
   * that was sent in. A `Titlebar` that returned an empty `div` would pass
   * every assertion about the words that used to be on it and leave the
   * defect exactly as it is, so what is asked here is whether the row exists.
   */
  it("draws no row, and so no space where one was", async () => {
    const { app, tab } = await both((m) => <m.Titlebar serverId={HERE.id} onSwitch={() => {}} />);
    expect(app).toContain("h-(--chrome-title)");
    expect(tab).toBe("");
  });

  /**
   * **The sentence goes with the row.**
   *
   * `org / user` was the last thing on it, kept on the grounds that a client
   * for several Firetowers has to answer *whose* everywhere. There is one
   * behind a served page, and a constant answers no question.
   */
  it("does not say org / user, because there is nothing it could mean", async () => {
    const { app, tab } = await both((m) => <m.Titlebar serverId={HERE.id} onSwitch={() => {}} />);
    expect(app).toContain("Acme");
    expect(app).toContain("kevin");
    expect(tab).not.toContain("Acme");
    expect(tab).not.toContain("kevin");
  });

  /**
   * **The bootstrap window too, which is the one easy to miss.**
   *
   * `App.tsx` renders the bar twice — once under `Starting`, which is up only
   * while the keychain answers, and once in `Window`. The first is where a
   * gate written at the call site gets forgotten, so the gate is inside the
   * component and this is the assertion that it is: the bar is handed a null
   * server, the shape `Starting` passes, and still draws nothing.
   */
  it("is absent before a Firetower is known, the same as after", async () => {
    const { app, tab } = await both((m) => <m.Titlebar serverId={null} onSwitch={() => {}} />);
    expect(app).toContain("Firetower");
    expect(tab).toBe("");
  });

  /* The window keeps every part of it. The pair is the point: the easy way to
     overdo this is a condition that is wrong in both directions, which reads
     as a clean browser while the installed build has quietly lost its
     chrome. `no-drag` is the half of the drag region a static render can
     see — the region itself is a `mousedown` handler, which
     `installed-only.test.tsx` calls directly. */
  it("is untouched in a window — gutter, drag region and switcher", async () => {
    const { app } = await both((m) => <m.Titlebar serverId={HERE.id} onSwitch={() => {}} />);
    expect(app).toContain("var(--chrome-lights)");
    expect(app).toContain("Switch Firetower");
    expect(app).toContain("server-mark");
    expect(app).toContain("no-drag");
  });

  /* Off a Mac the window has no frame and draws its own buttons — still, and
     still nowhere else. Pinned to Windows rather than inherited from whatever
     machine the suite runs on. */
  it("still draws the window's own buttons off a Mac", async () => {
    vi.resetModules();
    vi.stubGlobal("navigator", { platform: "Win32" });
    stubWindow();
    shell.bridge.native = true;
    fleet.rows = [{ backend: HERE, sessions: [], error: null } satisfies Fleet];
    const { Titlebar } = await import("~/ui/Titlebar");
    const html = renderToStaticMarkup(
      <QueryClientProvider client={cache()}>
        <Titlebar serverId={HERE.id} onSwitch={() => {}} />
      </QueryClientProvider>,
    );
    for (const control of ["Minimize", "Maximize", "Close"]) expect(html).toContain(control);
    expect(html).not.toContain("var(--chrome-lights)");
  });
});

/* ── 2 · Where the panel toggle went ──────────────────────────────────── */

/**
 * The panel's head, in each of the two states it can be in.
 *
 * `Rail` renders the panel when it is pinned, and when it is not but a
 * destination is being previewed. A static render cannot hover, so the
 * floating case is drawn by asking `RailPanel` for it directly — which is
 * also the honest shape of the question, since what is under test is the head
 * and not the hysteresis that gets you there.
 */
const head = (m: Parts, pinned: boolean) => (
  <m.StartProvider>
    <m.RailPanel
      at="home"
      floating={!pinned}
      stale={false}
      pin={{ pinned, set: () => {} }}
      onEnter={() => {}}
      onLeave={() => {}}
    />
  </m.StartProvider>
);

describe("the panel's own toggle", () => {
  /**
   * **The control that had to move before the bar could go.**
   *
   * The bar held the only pointer-driven way to pin the panel: pressing a
   * destination opens it and never shuts it, and the head's glyph only ever
   * closed. Delete the bar without this and `⌘\` is the whole of it — which
   * is also gone in a browser, so the panel would have been collapsible and
   * not reopenable at all.
   */
  it("offers the way back in, from the preview, in both clients", async () => {
    const { app, tab } = await both((m) => head(m, false));
    for (const html of [app, tab]) {
      expect(html).toContain("Keep this panel open");
      /* And not the other direction, which would be a control claiming to
         hide a panel that is already hidden. */
      expect(html).not.toContain("Hide this panel");
    }
  });

  /* And the way out, unchanged, which is what the head has always had. */
  it("offers the way out when it is pinned, in both clients", async () => {
    const { app, tab } = await both((m) => head(m, true));
    for (const html of [app, tab]) {
      expect(html).toContain("Hide this panel");
      expect(html).not.toContain("Keep this panel open");
    }
  });

  /**
   * **Reachable by pointer in both states, which is the acceptance.**
   *
   * Stated as the thing somebody has to be able to do rather than as two
   * labels: in each state there is exactly one button in the head that
   * changes the panel's width, and it is a button rather than a hint on
   * something else.
   */
  it("is one button, in one slot, in whichever state the panel is in", async () => {
    for (const pinned of [true, false]) {
      const { tab } = await both((m) => head(m, pinned));
      const toggles = [...tab.matchAll(/<button[^>]*aria-label="(Hide this panel|Keep this panel open)"/g)];
      expect(toggles).toHaveLength(1);
    }
  });

  /* `⌘\` is still advertised on it in a window, and still not in a browser —
     `advertisedKey` is unchanged and this is the pin half of it, which did
     not exist to be asserted before. */
  it("names ⌘\\ on it in a window and nothing in a browser", async () => {
    const { app, tab } = await both((m) => head(m, false));
    expect(app).toContain("Keep this panel open  ⌘\\");
    expect(tab).toContain('title="Keep this panel open"');
    expect(tab).not.toContain("⌘\\");
  });

  /**
   * **And the rail hands it both directions**, rather than the head having
   * grown a second opinion about what pinning means.
   *
   * At the source, because a pinned render cannot tell a `pin.set(false)`
   * from the `onCollapse` it replaced — the drawn output is the same glyph
   * with the same label. What there is to protect is that one prop carries
   * both answers, so the pair cannot drift into two props set from two
   * places.
   */
  it("is set from the rail's one answer, not from two", async () => {
    const { readFileSync } = await import("node:fs");
    const rail = readFileSync(new URL("./Rail.tsx", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(rail).toContain("pin={{");
    expect(rail).toContain("setPinned(next)");
    /* The prop this replaced, in any spelling: a panel still given only the
       collapse is a panel with no way back. */
    expect(rail).not.toMatch(/onCollapse\s*=/);
  });
});

/* ── 3 · Pinned by default, so the common case needs no hover ─────────── */

describe("what a browser is left with", () => {
  /**
   * The panel is pinned on every destination but a workspace, so the ordinary
   * screen still has its head and its toggle on it without hovering anything.
   * Worth asserting once: the hover route is the recovery, not the only way
   * in, and a regression that unpinned by default would make the whole of the
   * above the only path.
   */
  it("draws the panel pinned on the dashboard, with its toggle on it", async () => {
    const { tab } = await both((m) => (
      <m.StartProvider>
        <m.Rail backend={HERE} onSwitch={() => {}} onForgot={() => {}} />
      </m.StartProvider>
    ));
    expect(tab).toContain("data-rail-panel");
    expect(tab).toContain("Hide this panel");
  });

  /**
   * And a workspace, where the panel is collapsed by default and `⌘\` belongs
   * to the inspector rather than to the rail. Nothing of the rail's panel is
   * drawn at rest there — which is correct, and is why the hover preview is
   * the way back and why the glyph on it has to be the pin.
   */
  it("leaves a workspace's rail panel collapsed, as it always has", async () => {
    const { tab } = await both(
      (m) => (
        <m.StartProvider>
          <m.Rail backend={HERE} onSwitch={() => {}} onForgot={() => {}} />
        </m.StartProvider>
      ),
      { hash: "#/sessions/w_1" },
    );
    expect(tab).not.toContain("data-rail-panel");
  });
});

/**
 * **The bar going away is not the same as the space going away.**
 *
 * `--chrome-title` is the height a fixed overlay leaves clear so it does not
 * cover the window's own controls, and four of them position off it: the team
 * drawer and its scrim, the big-text room, and the expanded artifact. With
 * the bar gone from a tab the token was still 40px, so a modal scrim began
 * forty pixels down the viewport and the workspace header and inspector tabs
 * sat above it — undimmed, still reachable, while the page claimed to be
 * modal. QA measured it: bar height 0, scrim top 40.
 *
 * Every one of those overlays gives a *window* reason for the gap in its own
 * comment — the traffic lights, minimise and maximise at the top right — and
 * none of those things is in a browser tab.
 *
 * Asserted at the source: this is a custom property resolved by the
 * stylesheet, which these tests do not load, and a static render has no
 * computed styles to read. Driven in Chrome against the built sheet, where
 * the four overlays read 40/40/46/40 under the native shell and 0/0/6/0 in a
 * tab — `.bigroom` carrying a 6px offset of its own in both.
 */
describe("the space the title bar used to take", () => {
  const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
  const gate = readFileSync(new URL("../installed-app.ts", import.meta.url), "utf8");

  it("is zero in a tab, so an overlay that clears it clears nothing", () => {
    const at = css.indexOf('html[data-shell="browser"] {');
    expect(at, "an override keyed on the shell").toBeGreaterThan(-1);
    expect(css.slice(at, css.indexOf("}", at))).toMatch(/--chrome-title:\s*0/);
  });

  /** CSS cannot ask `bridge.native`, so the gate tells it — the same way
      `~/platform` tells it which desktop this is. */
  it("is told to the stylesheet by the gate itself", () => {
    expect(gate).toContain("documentElement.dataset.shell");
    expect(gate).toContain("installedApp() ?");
  });

  /** And the window keeps its gap: the controls it clears are still there. */
  it("is unchanged where there is a window", () => {
    const root = css.slice(css.indexOf("--chrome-title:"));
    expect(root).toMatch(/--chrome-title:\s*40px/);
  });
});

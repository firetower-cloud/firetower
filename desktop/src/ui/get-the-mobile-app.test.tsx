/**
 * The row, and the dialog behind it — every id and every string the design
 * contract names, in every state it names them for.
 *
 * `renderToStaticMarkup` with a seeded cache: no jsdom, no network, no
 * testing-library, as the earlier tickets on this branch established.
 *
 * ## Why there is a table of ids rather than a scattering of assertions
 *
 * The previous contract on this branch claimed completeness and was fourteen
 * ids short, and nothing said so until a QA pass counted them by hand. So the
 * table below is asserted **both ways**: every id the contract names is
 * rendered by some state, and every id rendered by some state is in the
 * contract. An id this file forgets fails it, and an id the product grows
 * without the contract fails it too.
 *
 * The same shape protects the copy: each string is checked where it is drawn,
 * and the strings that are *not* supposed to be there — a middle dot, a
 * keycap, an ember — are checked for their absence with something that can
 * see them when they are present.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getMeQueryKey } from "~/api/generated/auth/auth";
import type { Backend, Fleet } from "~/fleet";
import { boxFor, dialogWidth, TESTFLIGHT, type Found } from "./mobile-app";

/* ── The shell, stood in for, so the row can be drawn as both clients ──── */

const shell = vi.hoisted(() => ({ bridge: { native: true } }));
vi.mock("~/bridge", async (orig) => ({ ...(await orig<typeof import("~/bridge")>()), ...shell }));

const HERE: Backend = {
  id: "s_acme",
  org: "Acme",
  user: "kevin",
  mark: "Ac",
  url: "https://acme.example",
  reach: "live",
};
vi.mock("~/fleet", async (orig) => ({
  ...(await orig<typeof import("~/fleet")>()),
  useFleet: () => [{ backend: HERE, sessions: [], error: null } satisfies Fleet],
}));

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

function cache() {
  const c = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnMount: false } } });
  c.setQueryData(getMeQueryKey(), { user: { username: "kevin", role: "admin" }, organization: { name: "Acme" } });
  return c;
}

const draw = (node: React.ReactElement) =>
  renderToStaticMarkup(<QueryClientProvider client={cache()}>{node}</QueryClientProvider>);

/** The menu's first page, as one client or the other. */
async function menu(installed: boolean): Promise<string> {
  vi.resetModules();
  vi.stubGlobal("navigator", { platform: "MacIntel" });
  stubWindow();
  shell.bridge.native = installed;
  const { Profile } = await import("./ProfileMenu");
  return draw(
    <Profile
      backend={HERE}
      who="kevin"
      elsewhere={false}
      updates={{ label: "Update to 0.35.1", dot: true }}
      onSwitch={() => {}}
      onGetTheApp={() => {}}
      onClose={() => {}}
      onForgot={() => {}}
    />,
  );
}

/* ── The four states the dialog has ───────────────────────────────────── */

const APK_URL =
  "https://github.com/firetower-cloud/firetower/releases/download/mobile-v0.35.0/firetower-0.35.0.apk";

const STATES = {
  ready: { at: "ready", apk: { url: APK_URL, version: "0.35.0" } },
  looking: { at: "looking" },
  none: { at: "none" },
  unreachable: { at: "unreachable" },
} satisfies Record<string, Found>;

async function dialog(found: Found): Promise<string> {
  stubWindow();
  const { MobileApp } = await import("./GetTheMobileApp");
  return draw(<MobileApp address={HERE.url} found={found} onClose={() => {}} />);
}

/* ── Reading a render ─────────────────────────────────────────────────── */

/** Every `data-testid` in a rendering, in the order they are drawn. */
const idsIn = (html: string) => [...html.matchAll(/data-testid="([^"]*)"/g)].map((m) => m[1]);

/** What is inside the element with this id, as text. */
function textOf(html: string, id: string): string {
  const open = html.indexOf(`data-testid="${id}"`);
  if (open < 0) throw new Error(`no ${id} in this rendering`);
  const start = html.indexOf(">", open) + 1;
  // Elements here are shallow; the first close that balances is enough.
  let depth = 1;
  let i = start;
  for (; i < html.length && depth > 0; ) {
    const next = html.indexOf("<", i);
    if (next < 0) break;
    const closing = html[next + 1] === "/";
    const end = html.indexOf(">", next);
    const selfClosing = html[end - 1] === "/";
    if (closing) depth -= 1;
    else if (!selfClosing) depth += 1;
    i = end + 1;
    if (depth === 0) return content(html.slice(start, next));
  }
  return content(html.slice(start, i));
}

/** An element's text content: tags removed without standing in for them, so
 *  `on{" "}<a>GitHub</a>.` reads back as the sentence it renders as. */
const content = (s: string) =>
  s
    .replace(/<[^>]*>/g, "")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const words = (s: string) =>
  s
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

/** An element's own attributes, for the ones that carry copy. */
function attrsOf(html: string, id: string): string {
  const at = html.indexOf(`data-testid="${id}"`);
  if (at < 0) throw new Error(`no ${id} in this rendering`);
  return html.slice(html.lastIndexOf("<", at), html.indexOf(">", at) + 1);
}

beforeEach(() => {
  shell.bridge.native = true;
});

/* ══ the row ═══════════════════════════════════════════════════════════ */

describe("the row in the profile menu", () => {
  it("is drawn in both clients, identically", async () => {
    for (const installed of [true, false]) {
      const html = await menu(installed);
      expect(idsIn(html)).toContain("profile-get-the-mobile-app");
      expect(textOf(html, "profile-get-the-mobile-app")).toBe("Get the mobile app");
    }
  });

  /* The pair is the test. A gate that is wrong in both directions reads as a
     passing "it is there in a browser" while the installed build has quietly
     lost it — which is the shape `installed-only.test.tsx` exists for. */
  it("is the one row whose presence does not depend on the shell", async () => {
    const app = await menu(true);
    const tab = await menu(false);
    /* The switcher is the control that *does* depend on it, so the fixture is
       telling the two clients apart. */
    expect(app).toContain("Switch Firetower");
    expect(tab).not.toContain("Switch Firetower");
  });

  it("carries no keycap, in either client", async () => {
    for (const installed of [true, false]) {
      const html = await menu(installed);
      const row = html.slice(html.indexOf('data-testid="profile-get-the-mobile-app"'));
      const end = row.indexOf("</button>");
      expect(row.slice(0, end)).not.toContain("text-micro");
      /* And the fixture can see a keycap when there is one: Settings carries
         ⌘, in the installed client. */
      if (installed) expect(html).toContain("⌘,");
    }
  });

  it("sits under Updates and above the dev-only Style guide", async () => {
    const html = await menu(true);
    expect(html.indexOf("Update to 0.35.1")).toBeLessThan(
      html.indexOf('data-testid="profile-get-the-mobile-app"'),
    );
    /* No rule between them: the next hairline is below the new row, which is
       what "last in this group" means. */
    const between = html.slice(
      html.indexOf("Update to 0.35.1"),
      html.indexOf('data-testid="profile-get-the-mobile-app"'),
    );
    expect(between).not.toContain("bg-line");
  });

  /* `ProfileMenu.tsx`'s own rule: exactly two things may mark the avatar, and
     a new APK is not one of them. */
  it("never takes a mark, and nothing in this change reaches for ember", async () => {
    const html = await menu(true);
    const row = html.slice(html.indexOf('data-testid="profile-get-the-mobile-app"'));
    expect(row.slice(0, row.indexOf("</button>"))).not.toContain("bg-ember");
    for (const found of Object.values(STATES)) {
      expect(await dialog(found)).not.toContain("ember");
    }
  });
});

/* ══ the ids, both ways round ══════════════════════════════════════════ */

/**
 * The contract's table, in its order. Twenty-nine.
 *
 * `where` says which of the five renderings is expected to carry it, because
 * eight of them belong to one state of the Android column and asserting them
 * against every render would make four of the five assertions vacuous.
 */
const IDS: [id: string, where: "row" | "always" | keyof typeof STATES][] = [
  ["profile-get-the-mobile-app", "row"],
  ["mobile-app-scrim", "always"],
  ["mobile-app-dialog", "always"],
  ["mobile-app-title", "always"],
  ["mobile-app-lede", "always"],
  ["mobile-app-pair", "always"],
  ["mobile-app-iphone", "always"],
  ["mobile-app-iphone-code", "always"],
  ["mobile-app-iphone-name", "always"],
  ["mobile-app-iphone-line", "always"],
  ["mobile-app-iphone-link", "always"],
  ["mobile-app-iphone-url", "always"],
  ["mobile-app-iphone-copy", "always"],
  ["mobile-app-android", "always"],
  ["mobile-app-android-code", "ready"],
  ["mobile-app-android-waiting", "looking"],
  ["mobile-app-android-name", "always"],
  ["mobile-app-android-line", "always"],
  ["mobile-app-android-why", "none"],
  ["mobile-app-android-link", "looking"],
  ["mobile-app-android-url", "looking"],
  ["mobile-app-android-copy", "ready"],
  ["mobile-app-address", "always"],
  ["mobile-app-address-line", "always"],
  ["mobile-app-address-chip", "always"],
  ["mobile-app-address-value", "always"],
  ["mobile-app-address-copy", "always"],
  ["mobile-app-releases", "always"],
  ["mobile-app-done", "always"],
];

describe("the shared vocabulary of ids", () => {
  it("names twenty-nine, which is what the contract counted", () => {
    expect(IDS).toHaveLength(29);
    expect(new Set(IDS.map(([id]) => id)).size).toBe(29);
  });

  it("renders every one of them in the state it belongs to", async () => {
    const seen: Record<string, string[]> = { row: idsIn(await menu(true)) };
    for (const [key, found] of Object.entries(STATES)) seen[key] = idsIn(await dialog(found));

    for (const [id, where] of IDS) {
      const from = where === "always" ? Object.keys(STATES) : [where];
      for (const state of from) expect([state, id, seen[state].includes(id)]).toEqual([state, id, true]);
    }
  });

  /* The other direction, which is the one the previous contract failed: an id
     the product grows and the contract does not name. */
  it("renders nothing the contract does not name", async () => {
    const drawn = new Set([
      ...idsIn(await menu(true)),
      ...idsIn(await menu(false)),
      ...(await Promise.all(Object.values(STATES).map((f) => dialog(f)))).flatMap(idsIn),
    ]);
    expect([...drawn].filter((id) => !IDS.some(([named]) => named === id)).sort()).toEqual([]);
  });

  /* And every id in the table is reached by *some* state, so a row of the
     table cannot quietly describe something that is never drawn. */
  it("leaves no id in the table unreached", async () => {
    const drawn = new Set([
      ...idsIn(await menu(true)),
      ...(await Promise.all(Object.values(STATES).map((f) => dialog(f)))).flatMap(idsIn),
    ]);
    expect(IDS.map(([id]) => id).filter((id) => !drawn.has(id))).toEqual([]);
  });
});

/* ══ the copy, exactly ═════════════════════════════════════════════════ */

describe("what the dialog says", () => {
  it("names the room after the door it was opened by", async () => {
    const html = await dialog(STATES.ready);
    expect(textOf(html, "mobile-app-title")).toBe("Get the mobile app");
    expect(textOf(await menu(true), "profile-get-the-mobile-app")).toBe("Get the mobile app");
  });

  /* The only thing on screen that explains the absence of an App Store badge,
     which is otherwise the first thing a reader looks for. */
  it("says why there is no store badge", async () => {
    expect(textOf(await dialog(STATES.ready), "mobile-app-lede")).toBe(
      "Scan a code with the phone you want it on. Both are betas, and neither is on a store yet.",
    );
  });

  it("captions the iPhone column the same way in every state", async () => {
    for (const found of Object.values(STATES)) {
      const html = await dialog(found);
      expect(textOf(html, "mobile-app-iphone-name")).toBe("iPhone");
      expect(textOf(html, "mobile-app-iphone-line")).toBe("Through TestFlight");
      expect(textOf(html, "mobile-app-iphone-url")).toBe("testflight.apple.com");
      expect(attrsOf(html, "mobile-app-iphone-copy")).toContain('aria-label="Copy the TestFlight link"');
    }
  });

  it("reads out the link rather than the URL, on each code", async () => {
    const html = await dialog(STATES.ready);
    expect(attrsOf(html, "mobile-app-iphone-code")).toContain(
      `aria-label="iPhone, through TestFlight: ${TESTFLIGHT}"`,
    );
    expect(attrsOf(html, "mobile-app-android-code")).toContain(`aria-label="Android, an APK: ${APK_URL}"`);
  });

  it("captions the Android column by what the lookup found", async () => {
    const ready = await dialog(STATES.ready);
    expect(textOf(ready, "mobile-app-android-name")).toBe("Android");
    expect(textOf(ready, "mobile-app-android-line")).toBe("An APK, version 0.35.0");
    expect(textOf(ready, "mobile-app-android-url")).toBe("firetower-0.35.0.apk");
    expect(attrsOf(ready, "mobile-app-android-copy")).toContain('aria-label="Copy the APK link"');

    const looking = await dialog(STATES.looking);
    expect(textOf(looking, "mobile-app-android-line")).toBe("An APK");
    expect(textOf(looking, "mobile-app-android-waiting")).toBe("Looking for the latest release…");
    /* Holding its place, with nothing to take. */
    expect(textOf(looking, "mobile-app-android-url")).toBe("—");
    expect(attrsOf(looking, "mobile-app-android-link")).toContain('data-dead="1"');

    expect(textOf(await dialog(STATES.none), "mobile-app-android-waiting")).toBe(
      "No release carries an APK yet",
    );
    expect(textOf(await dialog(STATES.none), "mobile-app-android-why")).toBe(
      "The Android build has not been published yet. Every release is on GitHub.",
    );

    expect(textOf(await dialog(STATES.unreachable), "mobile-app-android-waiting")).toBe(
      "Couldn’t reach GitHub",
    );
    expect(textOf(await dialog(STATES.unreachable), "mobile-app-android-why")).toBe(
      "A Firetower on a private network often can’t. The APK is on the releases page.",
    );
  });

  it("gives the address with its scheme, because the phone asks for an origin", async () => {
    const html = await dialog(STATES.ready);
    expect(textOf(html, "mobile-app-address-line")).toBe(
      "The app asks which Firetower to connect to. This one is:",
    );
    expect(textOf(html, "mobile-app-address-value")).toBe("https://acme.example");
    expect(attrsOf(html, "mobile-app-address-copy")).toContain('aria-label="Copy the address"');
  });

  it("points at the releases index for everything it cannot observe", async () => {
    const html = await dialog(STATES.ready);
    expect(textOf(html, "mobile-app-releases")).toBe("Every release is on GitHub.");
    expect(html).toContain('href="https://github.com/firetower-cloud/firetower/releases"');
  });

  it("closes with Done", async () => {
    expect(textOf(await dialog(STATES.ready), "mobile-app-done")).toBe("Done");
  });

  /* `STYLE.md`'s second habit, in the dialog this change adds. The row above
     this one in the menu has one and is pre-existing — see the hand-back. */
  it("joins no two facts with a middle dot, in any state", async () => {
    for (const found of Object.values(STATES)) {
      expect(words(await dialog(found))).not.toContain("·");
    }
    /* The fixture can see one: the menu's own switcher sub-line has it. */
    expect(words(await menu(true))).toContain("·");
  });

  /* `.eyebrow` is retired on the desk and `STYLE.md`'s first habit is an
     ALL-CAPS label anywhere. The section label above the address is a short
     sentence instead, which is what `.legend` is for. */
  it("writes no tracked-out capitals", async () => {
    const shouting = (html: string) => /\beyebrow\b|\buppercase\b|tracking-wider/.test(html);
    for (const found of Object.values(STATES)) expect(shouting(await dialog(found))).toBe(false);
    /* The check can see one when there is one. */
    expect(shouting('<p class="eyebrow">GET THE APP</p>')).toBe(true);
  });
});

/* ══ the two components, and the seam between them ═════════════════════ */

/**
 * The exported pair is `GetTheMobileApp`, which reads the feed, and
 * `MobileApp`, which draws what it found. Everything above asserts the second;
 * this asserts that the first is actually wired to it, so the split is a
 * structure rather than a way of testing something nothing renders.
 */
describe("the component the menu opens", () => {
  it("draws the dialog, in the state a lookup that has not answered is in", async () => {
    stubWindow();
    vi.stubGlobal("fetch", () => new Promise(() => {}));
    const { GetTheMobileApp } = await import("./GetTheMobileApp");
    const html = draw(<GetTheMobileApp address={HERE.url} onClose={() => {}} />);
    expect(idsIn(html)).toContain("mobile-app-dialog");
    /* A static render runs no effects, so this is the state before the one
       request goes out — which is the same state as while it is out. */
    expect(textOf(html, "mobile-app-android-waiting")).toBe("Looking for the latest release…");
    expect(textOf(html, "mobile-app-address-value")).toBe(HERE.url);
  });
});

/* ══ the shape, which is where the two measured things live ════════════ */

describe("the dialog's own geometry", () => {
  it("is as wide as its codes say, not as wide as a literal says", async () => {
    const ready = await dialog(STATES.ready);
    expect(attrsOf(ready, "mobile-app-dialog")).toContain(
      `width:${dialogWidth(boxFor([TESTFLIGHT, APK_URL]))}px`,
    );

    /* The same dialog with a version-7 APK URL is wider — which is the whole
       reason the number is not written down. */
    const longer = APK_URL.replace(/0\.35\.0/g, "0.35.0-rc.1");
    const bigger = await dialog({ at: "ready", apk: { url: longer, version: "0.35.0-rc.1" } });
    const widths = [ready, bigger].map(
      (html) => /width:(\d+)px/.exec(attrsOf(html, "mobile-app-dialog"))![1],
    );
    expect(Number(widths[1])).toBeGreaterThan(Number(widths[0]));
  });

  it("does not move when the lookup lands", async () => {
    const widthOf = (html: string) => /width:(\d+)px/.exec(attrsOf(html, "mobile-app-dialog"))![1];
    const settled = widthOf(await dialog(STATES.ready));
    for (const found of Object.values(STATES)) expect(widthOf(await dialog(found))).toBe(settled);
  });

  /* The placeholder holds the code's footprint, for the same reason. */
  it("stands the placeholder in the code's exact footprint", async () => {
    const box = boxFor([TESTFLIGHT, APK_URL]);
    const html = await dialog(STATES.looking);
    const wait = attrsOf(html, "mobile-app-android-waiting");
    expect(wait).toContain(`width:${box}px`);
    expect(wait).toContain(`height:${box}px`);
    expect(wait).toContain('role="status"');
  });

  it("draws both codes at the same size, which the longer URL sets", async () => {
    const html = await dialog(STATES.ready);
    const box = boxFor([TESTFLIGHT, APK_URL]);
    for (const id of ["mobile-app-iphone-code", "mobile-app-android-code"]) {
      expect(attrsOf(html, id)).toContain(`width="${box}"`);
    }
  });

  /**
   * **The wrapper scrolls, which `Confirm.tsx`'s does not.** This dialog is
   * 444 × 566 against a 560px minimum window, so copying that wrapper verbatim
   * puts *Done* 55px below the fold with no way to reach it.
   */
  it("scrolls rather than putting its own button out of reach", async () => {
    const scrim = attrsOf(await dialog(STATES.ready), "mobile-app-scrim");
    expect(scrim).toContain("overflow-y-auto");

    /* And the thing it was copied from still does not, which is what makes
       the line above a difference rather than a coincidence. */
    const confirm = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("./Confirm.tsx", import.meta.url), "utf8"),
    );
    expect(confirm).not.toContain("overflow-y-auto");
  });

  it("is dismissed the three ways Confirm's dialog is", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("./GetTheMobileApp.tsx", import.meta.url), "utf8"),
    );
    expect(source).toContain('e.key === "Escape"');
    expect(source).toContain("onMouseDown={onClose}");
    expect(source).toContain("<button ref={done} onClick={onClose}");
  });

  it("labels itself by its own title", async () => {
    const dlg = attrsOf(await dialog(STATES.ready), "mobile-app-dialog");
    expect(dlg).toContain('role="dialog"');
    expect(dlg).toContain('aria-modal="true"');
    expect(dlg).toContain('aria-labelledby="mobile-app-title"');
    expect(await dialog(STATES.ready)).toContain('id="mobile-app-title"');
  });
});

/* ══ the four classes, and the one that was already taken ══════════════ */

/**
 * **A class this change adds must not already exist.**
 *
 * The contract lists `.chip` as a new class. It is not: `styles.css` has had
 * one since the composer — a 30px pill at `border-radius: 99px`, worn eleven
 * times across `StartComposer.tsx` and `NewSchedule.tsx`. A second block under
 * that name would have won on source order and quietly restyled every one of
 * them, in two screens this ticket has nothing to do with, with nothing in
 * `tsc`, the suite or `just check-style` able to see it. So the class is
 * `.well` here, and this is the check that would have caught it.
 */
describe("the classes this change adds", () => {
  /* Both sheets the desk loads. `globals.css` is byte-shared with the web
     client, so a name taken there is taken here too. */
  const STYLES = ["../styles.css", "../globals.css"]
    .map((f) => readFileSync(new URL(f, import.meta.url), "utf8"))
    .join("\n");
  /** Where this change's own block starts. Everything before it is somebody
   *  else's, which is the whole question. */
  const MINE = STYLES.indexOf("── Get the mobile app ──");

  /** Rules that style this bare class name, before this change's block. */
  const alreadyTaken = (name: string) =>
    [...STYLES.slice(0, MINE).matchAll(new RegExp(`^\\s*(?:\\[data-theme="\\w+"\\] )?\\.${name}[\\s{,:[]`, "gm"))]
      .length;

  it("finds the collision the contract did not", () => {
    expect(MINE).toBeGreaterThan(0);
    /* The matcher can see one. If this ever reaches 0 the four assertions
       below are passing because the matcher stopped working. */
    expect(alreadyTaken("chip")).toBeGreaterThan(0);
  });

  /**
   * What the dialog deliberately borrows, and nothing else may be on this
   * list. `.dlg` and `.say` are `Confirm.tsx`'s, `.btn.plain` is the button,
   * and `.codes` only ever appears compounded onto `.dlg`.
   */
  const BORROWED = ["dlg", "codes", "say", "btn", "plain"];

  /** Every class the dialog actually wears, across all four states. */
  async function worn(): Promise<string[]> {
    const out = new Set<string>();
    for (const found of Object.values(STATES)) {
      for (const m of (await dialog(found)).matchAll(/class="([^"]*)"/g)) {
        for (const name of m[1].split(/\s+/).filter(Boolean)) out.add(name);
      }
    }
    return [...out];
  }

  /* Derived from the markup rather than listed, because a list would have
     passed this change's own near-miss: renaming the class in both places
     leaves a literal list naming something nobody wears. */
  it("wears no class the sheet already styles for somebody else", async () => {
    const clashes = (await worn())
      .filter((name) => !BORROWED.includes(name))
      .filter((name) => alreadyTaken(name) > 0);
    expect(clashes.sort()).toEqual([]);
  });

  it("styles each of its own classes exactly where this change put them", async () => {
    const mine = (await worn()).filter((name) => !BORROWED.includes(name));
    /* Not vacuous: the dialog really does wear classes this sheet styles. */
    const styled = mine.filter(
      (name) => new RegExp(`^\\s*(?:\\[data-theme="\\w+"\\] )?\\.${name}[\\s{,:[]`, "m").test(STYLES),
    );
    expect(styled.sort()).toEqual(["qr", "qrwait", "well"]);
  });
});

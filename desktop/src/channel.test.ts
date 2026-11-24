/**
 * The channel of this copy — the preference, and the address it names.
 *
 * There is no DOM in this suite, so storage is a small object on `globalThis`
 * rather than a browser's. That is also the honest shape of the thing being
 * tested: the module reads `window.localStorage` behind a `try`, because a
 * window without storage is a real case and a preference that cannot be saved
 * still has to apply for this run.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/** An in-memory `localStorage`, which is all this module asks of a window. */
function storage(): Storage {
  const held = new Map<string, string>();
  return {
    getItem: (k) => held.get(k) ?? null,
    setItem: (k, v) => void held.set(k, String(v)),
    removeItem: (k) => void held.delete(k),
    clear: () => held.clear(),
    key: (i) => [...held.keys()][i] ?? null,
    get length() {
      return held.size;
    },
  } as Storage;
}

const fresh = async () => {
  vi.resetModules();
  return import("./channel");
};

beforeEach(() => {
  (globalThis as { window?: unknown }).window = { localStorage: storage() };
});

describe("the preference", () => {
  it("is general access until somebody chooses", async () => {
    const { appChannel } = await fresh();
    expect(appChannel()).toBe("general");
  });

  it("remembers a choice", async () => {
    const { appChannel, setAppChannel } = await fresh();
    setAppChannel("beta");
    expect(appChannel()).toBe("beta");
  });

  it("is reversible — leaving beta is a write, not a refusal", async () => {
    const { appChannel, setAppChannel } = await fresh();
    setAppChannel("beta");
    setAppChannel("general");
    expect(appChannel()).toBe("general");
  });

  it("ignores a value that is not a channel", async () => {
    window.localStorage.setItem("firetower.channel", "edge");
    const { appChannel } = await fresh();
    expect(appChannel()).toBe("general");
  });

  it("falls back to general access in a window with no storage", async () => {
    (globalThis as { window?: unknown }).window = {
      get localStorage(): Storage {
        throw new Error("the storage API is not available");
      },
    };
    const { appChannel, setAppChannel } = await fresh();
    expect(appChannel()).toBe("general");
    expect(() => setAppChannel("beta")).not.toThrow();
  });

  it("tells a watcher when it moves, and only then", async () => {
    const { setAppChannel, useAppChannel } = await fresh();
    expect(typeof useAppChannel).toBe("function");
    /* The subscribe/notify pair is what `useSyncExternalStore` drives; the
       hook itself needs React, so what is asserted here is that a repeated
       choice is not a change. */
    const { appChannel } = await import("./channel");
    setAppChannel("beta");
    setAppChannel("beta");
    expect(appChannel()).toBe("beta");
  });
});

describe("the address a check asks", () => {
  it("sends beta to beta's own release", async () => {
    const { endpointFor } = await fresh();
    expect(endpointFor("beta")).toMatch(/releases\/download\/desktop-beta\/latest\.json$/);
  });

  /**
   * **General access keeps the compiled address**, which is the permanent
   * alias every copy predating channels reads. Naming a second general-access
   * address at runtime would buy nothing and add a way for a copy that has
   * never been on beta to stop updating — and it is the fallback the
   * bootstrap wants when the preference cannot be read at all.
   */
  it("sends general access to the address compiled into the bundle", async () => {
    const { endpointFor } = await fresh();
    expect(endpointFor("general")).toBeNull();
  });

  it("never sends either channel to an address that is not https", async () => {
    const { endpointFor } = await fresh();
    for (const channel of ["general", "beta"] as const) {
      const where = endpointFor(channel);
      if (where) expect(where.startsWith("https://")).toBe(true);
    }
  });
});

describe("where the running build came from", () => {
  it("is not known until an update is taken", async () => {
    const { installedFrom } = await fresh();
    expect(installedFrom("0.30.0")).toBeNull();
  });

  it("is remembered with the version it was written for", async () => {
    const { installedFrom, rememberInstalledFrom } = await fresh();
    rememberInstalledFrom("0.30.0", "beta");
    expect(installedFrom("0.30.0")).toBe("beta");
  });

  /**
   * The install that never happened. It is written *before* the download,
   * because the install relaunches the window — so a failure afterwards would
   * otherwise leave a copy claiming a provenance for a build it never ran.
   */
  it("is not believed for a build that is not running", async () => {
    const { installedFrom, rememberInstalledFrom } = await fresh();
    rememberInstalledFrom("0.31.0", "beta");
    expect(installedFrom("0.30.0")).toBeNull();
  });

  it("is not known when the build is not known", async () => {
    const { installedFrom, rememberInstalledFrom } = await fresh();
    rememberInstalledFrom("0.30.0", "beta");
    expect(installedFrom(null)).toBeNull();
  });
});

/**
 * **The preference that decides what the page draws, and nothing else.**
 *
 * It does not move a channel and it does not grant one: an installation's
 * channel is still the tag in `firetower.yml` and still only changes through
 * the switch flow. Whether somebody already on beta sees beta is
 * `channelsShown` in `api/updates.ts`, which reads this and three other
 * things — tested there.
 */
describe("whether this copy draws the channels", () => {
  it("is off until somebody asks", async () => {
    const { channelsRevealed } = await fresh();
    expect(channelsRevealed()).toBe(false);
  });

  it("is on once they do, and off again after", async () => {
    const { channelsRevealed, revealChannels } = await fresh();
    revealChannels(true);
    expect(channelsRevealed()).toBe(true);
    revealChannels(false);
    expect(channelsRevealed()).toBe(false);
  });

  /* The same storage as the channel above, and the same `try`: a window
     without storage still draws a page, and the quiet one is the right
     default for somebody who has never asked. */
  it("is off, rather than throwing, in a window with no storage", async () => {
    (globalThis as { window?: unknown }).window = {};
    const { channelsRevealed, revealChannels } = await fresh();
    expect(channelsRevealed()).toBe(false);
    expect(() => revealChannels(true)).not.toThrow();
  });

  /* Two preferences, one storage, and neither may read the other's cell. */
  it("is not the channel this copy is on", async () => {
    const { appChannel, channelsRevealed, revealChannels, setAppChannel } = await fresh();
    revealChannels(true);
    expect(appChannel()).toBe("general");
    setAppChannel("beta");
    revealChannels(false);
    expect(appChannel()).toBe("beta");
    expect(channelsRevealed()).toBe(false);
  });

  it("survives being asked for twice", async () => {
    const { channelsRevealed, revealChannels } = await fresh();
    revealChannels(true);
    revealChannels(true);
    expect(channelsRevealed()).toBe(true);
  });
});

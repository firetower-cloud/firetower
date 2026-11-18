import { beforeEach, describe, expect, it, vi } from "vitest";

/* The shell and the update path, stood in for. `shell` is reached into by the
   one test that asks what a browser tab does, so it is a live object rather
   than a value copied into the factory.

   **The seam is a module, not an inter-process call.** The check, the
   download and the install moved into Rust — an update is a resource the
   shell owns, and the manifest address can only be chosen there — so left
   alone every test below would have become an assertion about the arguments
   of an `invoke`. `~/update-shell` is three functions wide and exists so that
   these stayed assertions about behaviour. */
const shell = vi.hoisted(() => ({ bridge: { native: true, notify: vi.fn() } }));
const path = vi.hoisted(() => ({ check: vi.fn(), install: vi.fn(), version: vi.fn() }));

vi.mock("~/bridge", () => shell);
vi.mock("~/update-shell", () => ({
  check: (endpoint: string | null) => path.check(endpoint),
  install: (onProgress?: (p: unknown) => void) => path.install(onProgress),
  version: () => path.version(),
}));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));

/** One `check()` answer, as the shell hands it up. */
const release = (version: string, channel: string | null = null) => ({
  version,
  currentVersion: "0.19.0",
  notes: null,
  channel,
});

/** An in-memory `localStorage`: the channel preference is a real one here. */
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

/* The watch is module state, so every test gets its own copy of the module. */
const fresh = async () => {
  vi.resetModules();
  return import("./update");
};

/**
 * **The beta address as a fact, not as what the module currently returns.**
 *
 * This read `endpointFor("beta")` and compared it with what the check was
 * given, which is two readings of one thing: deleting the channel's effect on
 * the address moved both sides together and the test stayed green. #388's
 * rule caught it. The exact URL is pinned in `channel.test.ts`; what is
 * asserted here is that a copy on beta is sent somewhere else entirely.
 */
const BETA_ADDRESS = expect.stringContaining("desktop-beta");

beforeEach(() => {
  (globalThis as { window?: unknown }).window = { localStorage: storage() };
  shell.bridge.native = true;
  path.check.mockReset();
  path.install.mockReset().mockResolvedValue(undefined);
  path.version.mockReset().mockResolvedValue("0.19.0");
  shell.bridge.notify.mockReset();
});

describe("watching for a newer build", () => {
  it("says which build this is and which one is out", async () => {
    path.check.mockResolvedValue(release("0.20.0"));
    const { look, currentBuild } = await fresh();
    await look();
    expect(currentBuild().version).toBe("0.19.0");
    expect(currentBuild().newer).toBe("0.20.0");
  });

  it("answers the same object when a check changed nothing", async () => {
    path.check.mockResolvedValue(release("0.20.0"));
    const { look, currentBuild } = await fresh();
    await look();
    const first = currentBuild();
    await look();
    // Not `toEqual`: the identity is what stops every ten-minute check from
    // re-rendering the rail.
    expect(currentBuild()).toBe(first);
  });

  it("keeps what it found when the next check cannot be made", async () => {
    path.check.mockResolvedValueOnce(release("0.20.0")).mockRejectedValueOnce(new Error("offline"));
    const { look, currentBuild } = await fresh();
    await look();
    await look();
    expect(currentBuild().newer).toBe("0.20.0");
  });

  it("stops saying so once there is nothing out", async () => {
    path.check.mockResolvedValueOnce(release("0.20.0")).mockResolvedValueOnce(null);
    const { look, currentBuild } = await fresh();
    await look();
    await look();
    expect(currentBuild().newer).toBeNull();
  });

  it("still says which build this is when the check itself fails", async () => {
    path.check.mockRejectedValue(new Error("no signature"));
    const { look, currentBuild } = await fresh();
    await look();
    expect(currentBuild().version).toBe("0.19.0");
    expect(currentBuild().newer).toBeNull();
  });

  it("asks nothing at all in a browser tab", async () => {
    shell.bridge.native = false;
    path.check.mockResolvedValue(release("0.20.0"));
    const { look, currentBuild } = await fresh();
    await look();
    expect(path.check).not.toHaveBeenCalled();
    expect(currentBuild()).toEqual({
      version: null,
      newer: null,
      channel: "general",
      from: null,
      taking: null,
    });
  });

  it("asks once when two callers ask at the same moment", async () => {
    path.check.mockResolvedValue(release("0.20.0"));
    const { look } = await fresh();
    await Promise.all([look(), look()]);
    expect(path.check).toHaveBeenCalledTimes(1);
  });
});

/**
 * **A copy's channel is an address, chosen per check.**
 *
 * This is the whole of "takes effect at the next check, with no restart": the
 * preference is read when the check is made, and nothing is reloaded,
 * relaunched or re-initialised to make it count.
 */
describe("which address a check asks", () => {
  it("asks the compiled one for general access", async () => {
    path.check.mockResolvedValue(null);
    const { look } = await fresh();
    await look();
    expect(path.check).toHaveBeenCalledWith(null);
  });

  it("asks beta's for a copy on beta", async () => {
    const { setAppChannel } = await import("./channel");
    setAppChannel("beta");
    path.check.mockResolvedValue(release("0.30.0", "beta"));
    const { look } = await fresh();
    await look();
    expect(path.check).toHaveBeenCalledWith(BETA_ADDRESS);
  });

  it("picks the new channel up on the next check, with no restart", async () => {
    const { relaunch } = await import("@tauri-apps/plugin-process");
    const { setAppChannel } = await import("./channel");
    path.check.mockResolvedValue(null);
    const { look, currentBuild } = await fresh();
    await look();
    expect(path.check).toHaveBeenLastCalledWith(null);

    setAppChannel("beta");
    path.check.mockResolvedValue(release("0.30.0", "beta"));
    await look();
    expect(path.check).toHaveBeenLastCalledWith(BETA_ADDRESS);
    expect(currentBuild().newer).toBe("0.30.0");
    expect(currentBuild().channel).toBe("beta");
    expect(relaunch).not.toHaveBeenCalled();
  });

  /**
   * The preference moving under a check already in flight. `look()` hands a
   * second caller the one that is running, so without this the answer for the
   * channel somebody just left would be the one on their screen.
   */
  it("asks again when the channel moved while it was asking", async () => {
    const { setAppChannel } = await import("./channel");
    path.check.mockImplementation(async () => {
      if (path.check.mock.calls.length === 1) setAppChannel("beta");
      return null;
    });
    const { look, currentBuild } = await fresh();
    await look();
    expect(path.check).toHaveBeenCalledTimes(2);
    expect(path.check).toHaveBeenLastCalledWith(BETA_ADDRESS);
    expect(currentBuild().channel).toBe("beta");
  });

  it("does not loop when the channel keeps moving", async () => {
    const { setAppChannel } = await import("./channel");
    let flip = 0;
    path.check.mockImplementation(async () => {
      setAppChannel(flip++ % 2 === 0 ? "beta" : "general");
      return null;
    });
    const { look } = await fresh();
    await look();
    expect(path.check.mock.calls.length).toBeLessThanOrEqual(2);
  });

  /**
   * **The manifest's channel is read and never acted on.** The updater has no
   * channel concept; this field exists so a copy can say where a build came
   * from, and a reader who mistook it for a mechanism would be the defect the
   * implementation note is written against.
   */
  it("carries the manifest's channel through without branching on it", async () => {
    path.check.mockResolvedValue(release("0.20.0", "beta"));
    const { look, currentBuild } = await fresh();
    await look();
    expect(currentBuild().from).toBe("beta");
    // The address asked was still the preference's, not the manifest's.
    expect(path.check).toHaveBeenCalledWith(null);
  });
});

describe("taking it", () => {
  it("installs what the last check found", async () => {
    path.check.mockResolvedValue(release("0.20.0"));
    const { look, takeUpdate } = await fresh();
    await look();
    await takeUpdate();
    expect(path.install).toHaveBeenCalled();
  });

  it("refuses rather than installing nothing", async () => {
    path.check.mockResolvedValue(null);
    const { look, takeUpdate } = await fresh();
    await look();
    await expect(takeUpdate()).rejects.toThrow(/nothing to install/);
    expect(path.install).not.toHaveBeenCalled();
  });

  it("lets a failed download be said on the screen that asked", async () => {
    path.check.mockResolvedValue(release("0.20.0"));
    path.install.mockRejectedValue(new Error("the release is still uploading"));
    const { look, takeUpdate } = await fresh();
    await look();
    await expect(takeUpdate()).rejects.toThrow("the release is still uploading");
  });

  /** Or the screen loses its progress: a hundred megabytes with nothing behind it. */
  it("reports how far a download has got, and stops when it ends", async () => {
    path.check.mockResolvedValue(release("0.20.0"));
    const seen: (number | null)[] = [];
    path.install.mockImplementation(async (onProgress: (p: unknown) => void) => {
      onProgress({ downloaded: 50, total: 200 });
      seen.push(currentAt());
      onProgress({ downloaded: 200, total: 200 });
      seen.push(currentAt());
    });
    const mod = await fresh();
    const currentAt = () => mod.currentBuild().taking?.downloaded ?? null;
    await mod.look();
    await mod.takeUpdate();
    expect(seen).toEqual([50, 200]);
    expect(mod.currentBuild().taking).toBeNull();
  });

  /** Written before the download, because the install relaunches the window. */
  it("remembers which channel the build it installs came from", async () => {
    const { setAppChannel, installedFrom } = await import("./channel");
    setAppChannel("beta");
    path.check.mockResolvedValue(release("0.30.0", "beta"));
    const { look, takeUpdate } = await fresh();
    await look();
    await takeUpdate();
    expect(installedFrom("0.30.0")).toBe("beta");
  });
});

describe("the one interruption, at start-up", () => {
  it("offers the find, and installs on a yes", async () => {
    path.check.mockResolvedValue(release("0.20.0"));
    const { look, currentBuild, offerUpdate } = await fresh();
    await look();
    const ask = vi.fn().mockResolvedValue(true);
    await offerUpdate(currentBuild(), ask);
    expect(ask.mock.calls[0][0].title).toBe("0.20.0 is out.");
    expect(ask.mock.calls[0][0].body).toContain("0.19.0");
    expect(path.install).toHaveBeenCalled();
  });

  it("asks once a run, however many finds there are", async () => {
    path.check.mockResolvedValueOnce(release("0.20.0")).mockResolvedValueOnce(release("0.21.0"));
    const { look, currentBuild, offerUpdate } = await fresh();
    const ask = vi.fn().mockResolvedValue(false);
    await look();
    await offerUpdate(currentBuild(), ask);
    await look();
    await offerUpdate(currentBuild(), ask);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("says nothing when there is nothing out", async () => {
    path.check.mockResolvedValue(null);
    const { look, currentBuild, offerUpdate } = await fresh();
    await look();
    const ask = vi.fn().mockResolvedValue(true);
    await offerUpdate(currentBuild(), ask);
    expect(ask).not.toHaveBeenCalled();
  });

  it("tells somebody when the install they asked for did not happen", async () => {
    path.check.mockResolvedValue(release("0.20.0"));
    path.install.mockRejectedValue(new Error("the release is still uploading"));
    const { look, currentBuild, offerUpdate } = await fresh();
    await look();
    // The dialog is gone by the time this fails, so it cannot be the surface.
    await offerUpdate(currentBuild(), vi.fn().mockResolvedValue(true));
    expect(shell.bridge.notify).toHaveBeenCalledWith(
      "The update did not install",
      "the release is still uploading. Try it again in a few minutes.",
    );
  });
});

/**
 * The one failure that waiting does not fix.
 *
 * An update replaces the running copy in place. Where that copy lives
 * somewhere this account cannot write to, every retry fails the same way, and
 * "try it again in a few minutes" is an instruction to keep going round. It
 * is likeliest on Linux — the AppImage *is* the installation, and `/opt` is a
 * reasonable place to have put it — and there is no privilege prompt to
 * rescue it as there is on Windows. Nothing here branches on the platform:
 * the answer is the same wherever it happens.
 */
describe("what a failed install says to do next", () => {
  const cases = [
    "Permission denied (os error 13)",
    "failed to copy the new version: Permission denied (os error 13)",
    "Access is denied. (os error 5)",
    "Read-only file system (os error 30)",
    // `ETXTBSY`: the kernel refusing to write a file that is being executed,
    // which is what replacing a running AppImage in place is. The likeliest
    // of these on Linux, and it was being told to wait a few minutes — for a
    // condition that holds for exactly as long as Firetower is open.
    "Text file busy (os error 26)",
    // `EPERM`, which is not `EACCES`: an immutable file or a sandbox policy,
    // reaching somebody who has already checked that they own the directory.
    "Operation not permitted (os error 1)",
  ];

  it("sends somebody to a writable location, and not back round the loop", async () => {
    const { whyUpdateFailed } = await fresh();
    for (const said of cases) {
      const answer = whyUpdateFailed(new Error(said));
      expect(answer).toContain("somewhere you can write to");
      expect(answer).not.toContain("a few minutes");
      // The platform's own words are kept, at the end: they are what somebody
      // pastes into an issue.
      expect(answer).toContain(said);
    }
  });

  /**
   * **A Tauri command rejects with a bare string.** The install is one now, so
   * the platform's own sentence arrives here without an `Error` around it —
   * and a reader that only looked at `.message` would have dropped exactly the
   * half this function exists for.
   */
  it("reads the failure a command rejects with, which is a string", async () => {
    const { whyUpdateFailed } = await fresh();
    for (const said of cases) {
      expect(whyUpdateFailed(said)).toContain("somewhere you can write to");
    }
    expect(whyUpdateFailed("the release is still uploading")).toBe(
      "the release is still uploading. Try it again in a few minutes.",
    );
  });

  it("does not read a permission failure out of a number that merely starts with one", async () => {
    // `os error 1` and `os error 5` are on the list above, and the matching is
    // on text. Without a word boundary a dropped connection's `os error 110`
    // and a timeout's `os error 55` both become "move Firetower somewhere you
    // can write to", which is the wrong half of this function.
    const { whyUpdateFailed } = await fresh();
    for (const said of [
      "connection closed before message completed (os error 110)",
      "Resource temporarily unavailable (os error 11)",
      "No such file or directory (os error 2)",
      "os error 55",
    ]) {
      const answer = whyUpdateFailed(new Error(said));
      expect(answer).toContain("a few minutes");
      expect(answer).not.toContain("somewhere you can write to");
    }
  });

  it("still says try again for everything that might work next time", async () => {
    const { whyUpdateFailed } = await fresh();
    expect(whyUpdateFailed(new Error("the release is still uploading"))).toBe(
      "the release is still uploading. Try it again in a few minutes.",
    );
    expect(whyUpdateFailed(new Error("Network Error."))).toBe("Network Error. Try it again in a few minutes.");
  });

  it("has something to say about a failure that came with no words", async () => {
    const { whyUpdateFailed } = await fresh();
    expect(whyUpdateFailed(undefined)).toBe("That didn't work. Try it again in a few minutes.");
    expect(whyUpdateFailed({})).toBe("That didn't work. Try it again in a few minutes.");
  });
});

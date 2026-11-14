import { beforeEach, describe, expect, it, vi } from "vitest";

/* The shell and the updater plugin, stood in for. `shell` is reached into by
   the one test that asks what a browser tab does, so it is a live object
   rather than a value copied into the factory. */
const shell = vi.hoisted(() => ({ bridge: { native: true, notify: vi.fn() } }));
const plugin = vi.hoisted(() => ({ check: vi.fn(), getVersion: vi.fn() }));

vi.mock("~/bridge", () => shell);
vi.mock("@tauri-apps/plugin-updater", () => ({ check: () => plugin.check() }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: () => plugin.getVersion() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));

/** One `check()` answer: the metadata, and the resource behind it. */
const release = (version: string) => ({
  version,
  currentVersion: "0.19.0",
  close: vi.fn().mockResolvedValue(undefined),
  downloadAndInstall: vi.fn().mockResolvedValue(undefined),
});

/* The watch is module state, so every test gets its own copy of the module. */
const fresh = async () => {
  vi.resetModules();
  return import("./update");
};

beforeEach(() => {
  shell.bridge.native = true;
  plugin.check.mockReset();
  plugin.getVersion.mockReset().mockResolvedValue("0.19.0");
  shell.bridge.notify.mockReset();
});

describe("watching for a newer build", () => {
  it("says which build this is and which one is out", async () => {
    plugin.check.mockResolvedValue(release("0.20.0"));
    const { look, currentBuild } = await fresh();
    await look();
    expect(currentBuild()).toEqual({ version: "0.19.0", newer: "0.20.0" });
  });

  it("answers the same object when a check changed nothing", async () => {
    plugin.check.mockResolvedValue(release("0.20.0"));
    const { look, currentBuild } = await fresh();
    await look();
    const first = currentBuild();
    await look();
    // Not `toEqual`: the identity is what stops every ten-minute check from
    // re-rendering the rail.
    expect(currentBuild()).toBe(first);
  });

  it("closes the handle it replaces, and keeps the one it holds", async () => {
    const was = release("0.20.0");
    const now = release("0.21.0");
    plugin.check.mockResolvedValueOnce(was).mockResolvedValueOnce(now);
    const { look, currentBuild } = await fresh();
    await look();
    await look();
    expect(was.close).toHaveBeenCalled();
    expect(now.close).not.toHaveBeenCalled();
    expect(currentBuild().newer).toBe("0.21.0");
  });

  it("keeps what it found when the next check cannot be made", async () => {
    plugin.check.mockResolvedValueOnce(release("0.20.0")).mockRejectedValueOnce(new Error("offline"));
    const { look, currentBuild } = await fresh();
    await look();
    await look();
    expect(currentBuild().newer).toBe("0.20.0");
  });

  it("stops saying so once there is nothing out", async () => {
    plugin.check.mockResolvedValueOnce(release("0.20.0")).mockResolvedValueOnce(null);
    const { look, currentBuild } = await fresh();
    await look();
    await look();
    expect(currentBuild()).toEqual({ version: "0.19.0", newer: null });
  });

  it("still says which build this is when the check itself fails", async () => {
    plugin.check.mockRejectedValue(new Error("no signature"));
    const { look, currentBuild } = await fresh();
    await look();
    expect(currentBuild()).toEqual({ version: "0.19.0", newer: null });
  });

  it("asks nothing at all in a browser tab", async () => {
    shell.bridge.native = false;
    plugin.check.mockResolvedValue(release("0.20.0"));
    const { look, currentBuild } = await fresh();
    await look();
    expect(plugin.check).not.toHaveBeenCalled();
    expect(currentBuild()).toEqual({ version: null, newer: null });
  });

  it("asks once when two callers ask at the same moment", async () => {
    plugin.check.mockResolvedValue(release("0.20.0"));
    const { look } = await fresh();
    await Promise.all([look(), look()]);
    expect(plugin.check).toHaveBeenCalledTimes(1);
  });
});

describe("taking it", () => {
  it("installs what the last check found", async () => {
    const out = release("0.20.0");
    plugin.check.mockResolvedValue(out);
    const { look, takeUpdate } = await fresh();
    await look();
    await takeUpdate();
    expect(out.downloadAndInstall).toHaveBeenCalled();
  });

  it("refuses rather than installing nothing", async () => {
    plugin.check.mockResolvedValue(null);
    const { look, takeUpdate } = await fresh();
    await look();
    await expect(takeUpdate()).rejects.toThrow(/nothing to install/);
  });

  it("lets a failed download be said on the screen that asked", async () => {
    const out = release("0.20.0");
    out.downloadAndInstall.mockRejectedValue(new Error("the release is still uploading"));
    plugin.check.mockResolvedValue(out);
    const { look, takeUpdate } = await fresh();
    await look();
    await expect(takeUpdate()).rejects.toThrow("the release is still uploading");
  });
});

describe("the one interruption, at start-up", () => {
  it("offers the find, and installs on a yes", async () => {
    const out = release("0.20.0");
    plugin.check.mockResolvedValue(out);
    const { look, currentBuild, offerUpdate } = await fresh();
    await look();
    const ask = vi.fn().mockResolvedValue(true);
    await offerUpdate(currentBuild(), ask);
    expect(ask.mock.calls[0][0].title).toBe("0.20.0 is out.");
    expect(ask.mock.calls[0][0].body).toContain("0.19.0");
    expect(out.downloadAndInstall).toHaveBeenCalled();
  });

  it("asks once a run, however many finds there are", async () => {
    plugin.check.mockResolvedValueOnce(release("0.20.0")).mockResolvedValueOnce(release("0.21.0"));
    const { look, currentBuild, offerUpdate } = await fresh();
    const ask = vi.fn().mockResolvedValue(false);
    await look();
    await offerUpdate(currentBuild(), ask);
    await look();
    await offerUpdate(currentBuild(), ask);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("says nothing when there is nothing out", async () => {
    plugin.check.mockResolvedValue(null);
    const { look, currentBuild, offerUpdate } = await fresh();
    await look();
    const ask = vi.fn().mockResolvedValue(true);
    await offerUpdate(currentBuild(), ask);
    expect(ask).not.toHaveBeenCalled();
  });

  it("tells somebody when the install they asked for did not happen", async () => {
    const out = release("0.20.0");
    out.downloadAndInstall.mockRejectedValue(new Error("the release is still uploading"));
    plugin.check.mockResolvedValue(out);
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

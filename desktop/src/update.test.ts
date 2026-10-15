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
    expect(shell.bridge.notify).toHaveBeenCalledWith("The update did not install", "the release is still uploading");
  });
});

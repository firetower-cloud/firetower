/**
 * What happens to a token the OS keychain will not take.
 *
 * The bug this is written for: `remember()` discarded the rejection and
 * `write()` stripped the token out of `localStorage` because a keychain
 * *interface* existed — so signing in on a box with no Secret Service looked
 * perfect, and the next launch was the password field again with the server
 * still listed and nothing anywhere saying why.
 *
 * Two things are asserted, and the second one is the security constraint
 * rather than a nicety: the session is kept **in memory only**, and somebody
 * is told. A credential that fell back to `localStorage` would be a credential
 * any process under this uid can read — WebKitGTK writes that file at `0644`
 * under `0755` directories — so the registry's bytes are read back here and
 * checked for the token, on every path that holds one.
 *
 * All three paths, because the review's correction was that only the first had
 * ever been looked at: a first sign-in, a replaced password, and the one-time
 * move of a token out of an old build's registry file.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/* The shell, stood in for. A live object rather than values copied into the
   factory, so a test can make the keychain refuse. */
const shell = vi.hoisted(() => ({
  bridge: {
    native: true,
    secrets: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
  },
}));
vi.mock("~/bridge", () => shell);

const KEY = "firetower.servers";
const TOKEN = "ft_live_9c2bbe41";

/** `localStorage`, as the registry reaches for it — and readable back. */
const disk = new Map<string, string>();

beforeEach(() => {
  disk.clear();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => disk.get(k) ?? null,
      setItem: (k: string, v: string) => void disk.set(k, v),
      removeItem: (k: string) => void disk.delete(k),
    },
  });
  shell.bridge.secrets.get.mockReset().mockResolvedValue(null);
  shell.bridge.secrets.set.mockReset().mockResolvedValue(undefined);
  shell.bridge.secrets.delete.mockReset().mockResolvedValue(undefined);
});

/* The registry and the refusal are both module state, so every test takes its
   own copy of the module. */
const fresh = async () => {
  vi.resetModules();
  return import("./servers");
};

const server = (over: Record<string, unknown> = {}) => ({
  url: "https://ft.acme.example",
  serverId: "s_acme",
  org: "Acme",
  user: "kevin",
  token: TOKEN,
  addedAt: "2026-11-11T09:00:00.000Z",
  ...over,
});

/** What is actually on disk under the registry's key. */
const onDisk = () => disk.get(KEY) ?? "";

/* `remember` and `updateToken` do not await the keychain — the registry write
   must not wait on a round trip — so a refusal lands a microtask later. */
const settle = () => new Promise((r) => setTimeout(r, 0));

const refuse = () =>
  shell.bridge.secrets.set.mockRejectedValue(
    "Platform secure storage failure: DBus error: The name org.freedesktop.secrets was not provided by any .service files",
  );

describe("a keychain that refuses the token", () => {
  it("keeps the session in memory, and nowhere else, on a first sign-in", async () => {
    refuse();
    const S = await fresh();
    S.remember(server() as never);
    await settle();

    // The session works.
    expect(S.servers()[0]?.token).toBe(TOKEN);
    // And the token is in no on-disk store.
    expect(onDisk()).not.toContain(TOKEN);
    expect(JSON.parse(onDisk())[0].token).toBe("");
  });

  it("says so, naming the server it could not keep", async () => {
    refuse();
    const S = await fresh();
    S.remember(server() as never);
    await settle();

    expect(S.unkeptSignIn()).toBe("s_acme");
  });

  it("says so for a replaced password too", async () => {
    const S = await fresh();
    S.remember(server() as never);
    await settle();
    expect(S.unkeptSignIn()).toBe(null);

    // The password changed and the server answered with a new token.
    refuse();
    S.updateToken("s_acme", "ft_live_newer");
    await settle();

    expect(S.unkeptSignIn()).toBe("s_acme");
    expect(S.servers()[0]?.token).toBe("ft_live_newer");
    expect(onDisk()).not.toContain("ft_live_newer");
  });

  it("says so when an old build's token cannot be moved into it", async () => {
    // What a build that kept the token in the file left behind.
    disk.set(KEY, JSON.stringify([server()]));
    refuse();
    const S = await fresh();
    await S.hydrate();

    expect(S.unkeptSignIn()).toBe("s_acme");
    // Held for the session…
    expect(S.servers()[0]?.token).toBe(TOKEN);
    // …and taken out of the file anyway. A token that could not be moved
    // somewhere safe is not left somewhere unsafe.
    expect(onDisk()).not.toContain(TOKEN);
  });

  it("asks again the next time, once it has been said", async () => {
    refuse();
    const S = await fresh();
    S.remember(server() as never);
    await settle();

    S.unkeptSaid();
    expect(S.unkeptSignIn()).toBe(null);

    S.updateToken("s_acme", "ft_live_newer");
    await settle();
    expect(S.unkeptSignIn()).toBe("s_acme");
  });
});

describe("a keychain that works", () => {
  it("says nothing, and still keeps no token on disk", async () => {
    const S = await fresh();
    S.remember(server() as never);
    await settle();

    expect(S.unkeptSignIn()).toBe(null);
    expect(shell.bridge.secrets.set).toHaveBeenCalledWith("s_acme", TOKEN);
    expect(onDisk()).not.toContain(TOKEN);
  });

  it("reads the token back at the next launch", async () => {
    disk.set(KEY, JSON.stringify([server({ token: "" })]));
    shell.bridge.secrets.get.mockResolvedValue(TOKEN);
    const S = await fresh();
    await S.hydrate();

    expect(S.servers()[0]?.token).toBe(TOKEN);
    expect(S.unkeptSignIn()).toBe(null);
  });
});

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
 *
 * And then what happens *after* somebody is told, which is where the worse bug
 * was. `Back` on that card reaches `signedOut()`, which used to swallow a
 * failed keychain delete and leave the registry row in place — so a valid
 * older credential stayed in the keychain and the next launch that could reach
 * it signed straight back in. Anybody using the desktop afterwards got the
 * previous account with no password. The marker, the eras and the ordering
 * that fixes it are asserted at the bottom of this file, including the
 * interleaving the fix is really about: the keychain read is in flight while
 * the person presses the button.
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
const OUT_KEY = "firetower.signedOut";
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
  /* Ending a legacy sign-in tells its server so. Nothing here is online. */
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 204 }));
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

    expect(S.unkeptSignIn()).toEqual({ serverId: "s_acme", because: "signIn" });
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

    expect(S.unkeptSignIn()).toEqual({ serverId: "s_acme", because: "signIn" });
    expect(S.servers()[0]?.token).toBe("ft_live_newer");
    expect(onDisk()).not.toContain("ft_live_newer");
  });

  it("ends an old build's sign-in rather than run on it from a file", async () => {
    // What a build that kept the token in the file left behind.
    disk.set(KEY, JSON.stringify([server()]));
    refuse();
    const S = await fresh();
    await S.hydrate();

    // Said, and said as the other story: there is no session to offer.
    expect(S.unkeptSignIn()).toEqual({ serverId: "s_acme", because: "legacy" });
    // **Not held for the session.** This token is already in a world-readable
    // file that nothing here can scrub, so going on with it would keep a live
    // bearer token on the disk for the whole session — which is the one place
    // the memory-only claim did not hold.
    expect(S.servers()[0]?.token).toBe("");
    // Revoked with its own server, which is what makes those bytes worthless.
    expect(fetch).toHaveBeenCalledWith(
      "https://ft.acme.example/api/v1/auth/logout",
      expect.objectContaining({ method: "POST" }),
    );
    // And taken out of the file anyway.
    expect(onDisk()).not.toContain(TOKEN);
    // The address is still remembered; only the credential is gone.
    expect(S.servers()[0]?.url).toBe("https://ft.acme.example");
  });

  it("keeps an old build's sign-in where the keychain does take it", async () => {
    disk.set(KEY, JSON.stringify([server()]));
    const S = await fresh();
    await S.hydrate();

    expect(S.unkeptSignIn()).toBe(null);
    expect(S.servers()[0]?.token).toBe(TOKEN);
    expect(shell.bridge.secrets.set).toHaveBeenCalledWith("s_acme", TOKEN);
    expect(onDisk()).not.toContain(TOKEN);
    // Nothing was revoked: it was moved, not ended.
    expect(fetch).not.toHaveBeenCalled();
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
    expect(S.unkeptSignIn()).toEqual({ serverId: "s_acme", because: "signIn" });
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

/**
 * Signing out, when there is already a credential in the keychain.
 *
 * The one that mattered. Token A is in the keychain and good. Somebody signs
 * in again, gets token B, and the keychain refuses to store it — so the card
 * goes up and they press **Back**. `signedOut()` cleared memory, swallowed the
 * failed delete and left the row, so the next launch that could reach the
 * keyring read **A** and signed in with it. The person who declined is the one
 * it signs in, and anybody at that desk afterwards gets the account.
 */
describe("signing out of a server whose keychain still holds a credential", () => {
  /** What the next launch does with this registry and this keychain. */
  const relaunch = async () => {
    const S = await fresh();
    await S.hydrate();
    return S;
  };

  it("does not sign back in once the keychain is reachable again", async () => {
    // Launch one: A is in the keychain and signs us in.
    shell.bridge.secrets.get.mockResolvedValue("token_A");
    const S = await fresh();
    await S.hydrate();
    expect(S.servers.length).toBe(0); // nothing in the registry yet
    S.remember(server({ token: "token_A" }) as never);
    await settle();

    // A new sign-in arrives and the keychain will not take it.
    refuse();
    S.remember(server({ token: "token_B" }) as never);
    await settle();
    expect(S.unkeptSignIn()).toEqual({ serverId: "s_acme", because: "signIn" });

    // Back.
    S.unkeptSaid();
    S.signedOut("s_acme");
    expect(S.servers()[0]?.token).toBe("");

    // The next launch, with the keyring working again and A still in it.
    shell.bridge.secrets.get.mockResolvedValue("token_A");
    const next = await relaunch();
    expect(next.servers()[0]?.token).toBe("");
    expect(next.servers()[0]?.url).toBe("https://ft.acme.example");
    // And the stale credential is taken out now that it can be reached.
    expect(shell.bridge.secrets.delete).toHaveBeenCalledWith("s_acme");
  });

  it("stays signed out when the keychain refuses the delete as well", async () => {
    shell.bridge.secrets.get.mockResolvedValue("token_A");
    const S = await fresh();
    await S.hydrate();
    S.remember(server({ token: "token_A" }) as never);
    await settle();

    // Signing out cannot reach the keyring either.
    shell.bridge.secrets.delete.mockRejectedValue(new Error("keyring is locked"));
    S.signedOut("s_acme");
    await settle();

    // The marker is on disk, and it is not a secret.
    expect(JSON.parse(disk.get(OUT_KEY) ?? "[]")).toEqual(["s_acme"]);
    expect(disk.get(OUT_KEY)).not.toContain("token_A");

    // So the next launch refuses what is still in there.
    const next = await relaunch();
    expect(next.servers()[0]?.token).toBe("");
  });

  it("is not undone by a keychain read that was already in flight", async () => {
    // The interleaving the fix is really about: `hydrate` runs behind the
    // first frame, so the person can press Back while a read is pending.
    disk.set(KEY, JSON.stringify([server({ token: "" })]));
    let answer: (v: string) => void = () => {};
    shell.bridge.secrets.get.mockReturnValue(new Promise<string>((r) => (answer = r)));

    const S = await fresh();
    const hydrating = S.hydrate();

    // They sign in, it is refused, and they press Back — all while the read
    // above has not come back yet.
    refuse();
    S.remember(server({ token: "token_B" }) as never);
    await settle();
    S.unkeptSaid();
    S.signedOut("s_acme");

    // Only now does the keychain answer, with the credential from before.
    answer("token_A");
    await hydrating;

    expect(S.servers()[0]?.token).toBe("");
    expect(onDisk()).not.toContain("token_A");
  });

  it("does not let a pending read overwrite a sign-in that has landed", async () => {
    /* The other half of the race, and the one the marker cannot catch: there
       is no sign-out here at all. A read for the old credential is in flight,
       a new sign-in lands and is stored successfully, and then the read
       answers — with the token the new one replaced. */
    disk.set(KEY, JSON.stringify([server({ token: "" })]));
    let answer: (v: string) => void = () => {};
    shell.bridge.secrets.get.mockReturnValue(new Promise<string>((r) => (answer = r)));

    const S = await fresh();
    const hydrating = S.hydrate();

    S.remember(server({ token: "token_NEW" }) as never);
    await settle();
    expect(S.servers()[0]?.token).toBe("token_NEW");

    answer("token_OLD");
    await hydrating;

    expect(S.servers()[0]?.token).toBe("token_NEW");
  });

  it("signs back in only once a replacement has actually been stored", async () => {
    shell.bridge.secrets.get.mockResolvedValue("token_A");
    const S = await fresh();
    await S.hydrate();
    S.remember(server({ token: "token_A" }) as never);
    await settle();
    S.signedOut("s_acme");
    await settle();

    // Signing in again, still with nowhere to put it. Authenticating is not
    // what lifts the refusal — that is the whole shape of the bug.
    refuse();
    S.remember(server({ token: "token_C" }) as never);
    await settle();
    expect(JSON.parse(disk.get(OUT_KEY) ?? "[]")).toEqual(["s_acme"]);

    // Now the keyring takes it, and only now.
    shell.bridge.secrets.set.mockResolvedValue(undefined);
    S.remember(server({ token: "token_D" }) as never);
    await settle();
    expect(JSON.parse(disk.get(OUT_KEY) ?? "[]")).toEqual([]);

    shell.bridge.secrets.get.mockResolvedValue("token_D");
    const next = await relaunch();
    expect(next.servers()[0]?.token).toBe("token_D");
  });
});

/**
 * What the window is allowed to draw before the keychain has answered.
 *
 * `main.tsx` used to `await hydrate()` above the render, which made a Secret
 * Service read that never answers — a locked login keyring with a prompt
 * nobody answered — into a window with nothing in it at all. It renders first
 * now, so the one thing it needs back is "has the keychain spoken yet", and
 * the one thing that must be true is that it does not wait forever.
 */
describe("waiting for the keychain, with the window already up", () => {
  it("has not decided before the read comes back, and has after", async () => {
    disk.set(KEY, JSON.stringify([server({ token: "" })]));
    let answer: (v: string) => void = () => {};
    shell.bridge.secrets.get.mockReturnValue(new Promise<string>((r) => (answer = r)));

    const S = await fresh();
    expect(S.tokensKnown()).toBe(false);
    const hydrating = S.hydrate();
    expect(S.tokensKnown()).toBe(false);

    answer(TOKEN);
    await hydrating;
    expect(S.tokensKnown()).toBe(true);
    expect(S.servers()[0]?.token).toBe(TOKEN);
  });

  it("stops waiting on a read that never answers, and still takes it later", async () => {
    vi.useFakeTimers();
    try {
      disk.set(KEY, JSON.stringify([server({ token: "" })]));
      let answer: (v: string) => void = () => {};
      shell.bridge.secrets.get.mockReturnValue(new Promise<string>((r) => (answer = r)));

      const S = await fresh();
      const told: boolean[] = [];
      S.onServers(() => told.push(S.tokensKnown()));
      void S.hydrate();
      expect(S.tokensKnown()).toBe(false);

      // The prompt is still up and nothing has come back.
      await vi.advanceTimersByTimeAsync(3000);
      expect(S.tokensKnown()).toBe(true);
      expect(told).toContain(true);
      // Which is a door, not a session.
      expect(S.servers()[0]?.token).toBe("");

      // They unlock the keyring. The read was never abandoned.
      answer(TOKEN);
      await vi.advanceTimersByTimeAsync(0);
      expect(S.servers()[0]?.token).toBe(TOKEN);
    } finally {
      vi.useRealTimers();
    }
  });

  it("has nothing to wait for in a browser tab", async () => {
    const had = shell.bridge.secrets;
    (shell.bridge as { secrets: unknown }).secrets = null;
    try {
      disk.set(KEY, JSON.stringify([server()]));
      const S = await fresh();
      await S.hydrate();
      expect(S.tokensKnown()).toBe(true);
      // And the registry is where the token lives there, untouched.
      expect(S.servers()[0]?.token).toBe(TOKEN);
    } finally {
      (shell.bridge as { secrets: unknown }).secrets = had;
    }
  });
});

/**
 * The constraint the whole of this module exists under, re-asked of the paths
 * this change added.
 *
 * A security review fixed it and QA proved it on a real disk: the sign-in
 * token goes nowhere but process memory, and a search of 3,869 files in four
 * encodings found none of it. Two things here are new since — a marker saying
 * which servers have been signed out of, and a startup that renders before it
 * reads — so this asks the question again of **everything** the registry
 * writes rather than of the one key it used to.
 */
describe("nothing a token is in ever reaches the disk", () => {
  /** Every byte this module has written, under any key. */
  const everything = () => [...disk.entries()].map(([k, v]) => `${k}=${v}`).join("\n");

  it("not through a sign-in, a sign-out, a refusal or a relaunch", async () => {
    shell.bridge.secrets.get.mockResolvedValue(null);
    const S = await fresh();
    await S.hydrate();

    // Signed in, kept properly.
    S.remember(server({ token: "token_A" }) as never);
    await settle();
    expect(everything()).not.toContain("token_A");

    // Signed in again where the keychain refuses, which is the card's path.
    refuse();
    S.remember(server({ token: "token_B" }) as never);
    await settle();
    expect(everything()).not.toContain("token_B");

    // Back, which writes the marker.
    S.signedOut("s_acme");
    await settle();
    expect(everything()).not.toContain("token_A");
    expect(everything()).not.toContain("token_B");
    // The marker is a server id and nothing else.
    expect(JSON.parse(disk.get(OUT_KEY) ?? "[]")).toEqual(["s_acme"]);

    // And the relaunch that reads it writes nothing either.
    shell.bridge.secrets.get.mockResolvedValue("token_A");
    const next = await fresh();
    await next.hydrate();
    expect(everything()).not.toContain("token_A");
  });

  it("not on the legacy path, which is where it used to", async () => {
    disk.set(KEY, JSON.stringify([server()]));
    refuse();
    const S = await fresh();
    await S.hydrate();

    /* The bytes an older build wrote are still in the SQLite file WebKit
       keeps `localStorage` in — nothing in a webview can scrub those, and the
       fix is that the credential they hold has been revoked. What is asserted
       here is the part this module controls: it writes none of it back, and
       the value it reads is gone from the value it leaves. */
    expect(everything()).not.toContain(TOKEN);
    expect(S.servers()[0]?.token).toBe("");
  });
});

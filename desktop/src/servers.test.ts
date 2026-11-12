/**
 * What happens to a token the OS keychain will not take, and to a sign-out it
 * will not accept.
 *
 * The bug this was first written for: `remember()` discarded the rejection and
 * `write()` stripped the token out of `localStorage` because a keychain
 * *interface* existed — so signing in on a box with no Secret Service looked
 * perfect, and the next launch was the password field again with the server
 * still listed and nothing anywhere saying why.
 *
 * Two things are asserted about that, and the second is the security
 * constraint rather than a nicety: the session is kept **in memory only**, and
 * somebody is told. A credential that fell back to `localStorage` would be a
 * credential any process under this uid can read — WebKitGTK writes that file
 * at `0644` under `0755` directories — so the registry's bytes are read back
 * here and checked for the token, on every path that holds one.
 *
 * ---
 *
 * **Everything below that is about the opposite direction: a credential that
 * comes back when it should not.** Four separate failures were driven in the
 * installed `.deb`, and all four were the same mistake — something went wrong,
 * the code took the reassuring reading of it, and a sign-in somebody had
 * declined signed itself back in. Each has a test here, and each of those
 * tests fails if the line it is about is put back:
 *
 * - a keychain *read* that failed being read as "there is no credential here";
 * - a hydration snapshot landing on top of a newer sign-in to a later server;
 * - the note that forbids a restore failing to write, silently;
 * - a revocation that did not happen being announced as though it had.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/* The shell, stood in for. A live object rather than values copied into the
   factory, so a test can make the keychain refuse — or, which is the whole
   point of the three-valued answer, refuse to say. */
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

/** The keychain's three answers, and the two for a write. */
const held = (token: string) => ({ says: "held", token });
const absent = { says: "absent" };
const unknown = (why = "DBus error: The name org.freedesktop.secrets was not provided by any .service files") => ({
  says: "unknown",
  why,
});
const done = { says: "done" };
const refusedBy = (why = "no keyring") => ({ says: "refused", why });

/** `localStorage`, as the registry reaches for it — and readable back. */
const disk = new Map<string, string>();
/** Keys whose write is refused, for the storage failure that fails open. */
const unwritable = new Set<string>();

beforeEach(() => {
  disk.clear();
  unwritable.clear();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => disk.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (unwritable.has(k)) throw new Error("QuotaExceededError");
        disk.set(k, v);
      },
      removeItem: (k: string) => void disk.delete(k),
    },
  });
  shell.bridge.secrets.get.mockReset().mockResolvedValue(absent);
  shell.bridge.secrets.set.mockReset().mockResolvedValue(done);
  shell.bridge.secrets.delete.mockReset().mockResolvedValue(done);
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
/** Every byte this module has written, under any key. */
const everything = () => [...disk.entries()].map(([k, v]) => `${k}=${v}`).join("\n");
/** The stored row for a server, as the file has it. */
const rowFor = (serverId = "s_acme") =>
  (JSON.parse(onDisk() || "[]") as { serverId: string; kept?: boolean; token: string }[]).find(
    (s) => s.serverId === serverId,
  );

/* `remember` and `updateToken` do not await the keychain — the registry write
   must not wait on a round trip — so a refusal lands a microtask later. */
const settle = () => new Promise((r) => setTimeout(r, 0));

const refuse = () => shell.bridge.secrets.set.mockResolvedValue(refusedBy());

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
    expect(rowFor()?.token).toBe("");
  });

  it("says so, naming the server it could not keep", async () => {
    refuse();
    const S = await fresh();
    S.remember(server() as never);
    await settle();

    expect(S.unkeptSignIn()).toEqual({ serverId: "s_acme", because: "signIn", stale: false });
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

    expect(S.unkeptSignIn()).toEqual({ serverId: "s_acme", because: "signIn", stale: false });
    expect(S.servers()[0]?.token).toBe("ft_live_newer");
    expect(onDisk()).not.toContain("ft_live_newer");
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
    expect(S.unkeptSignIn()).toEqual({ serverId: "s_acme", because: "signIn", stale: false });
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
    disk.set(KEY, JSON.stringify([server({ token: "", kept: true })]));
    shell.bridge.secrets.get.mockResolvedValue(held(TOKEN));
    const S = await fresh();
    await S.hydrate();

    expect(S.servers()[0]?.token).toBe(TOKEN);
    expect(S.unkeptSignIn()).toBe(null);
  });
});

/**
 * The permission rule, which is the shape four bugs came out of not having.
 *
 * A credential may be restored only where the row *positively says* the
 * keychain is holding it. Everything else — a row from a build that never
 * recorded it, a row that says otherwise, a registry that will not parse —
 * grants nothing.
 */
describe("what authorises restoring a credential", () => {
  it("is the row saying the keychain confirmed it, and only that", async () => {
    const S = await fresh();
    S.remember(server() as never);
    await settle();
    // Written false up front, and true only once the keychain answered.
    expect(rowFor()?.kept).toBe(true);
  });

  it("is never granted by having authenticated, only by storing", async () => {
    refuse();
    const S = await fresh();
    S.remember(server() as never);
    await settle();

    expect(rowFor()?.kept).toBe(false);
    // So the next launch asks for a password, whatever is in the keychain.
    shell.bridge.secrets.get.mockResolvedValue(held("an_older_token"));
    const next = await fresh();
    await next.hydrate();
    expect(next.servers()[0]?.token).toBe("");
  });

  it("is never granted by a row that predates it, however good the credential", async () => {
    /* **The upgrade exception, deliberately removed.** A row with no `kept`
       used to be adopted the first time a read confirmed a credential. QA
       showed it cannot be made safe: the registry an older build's *failed*
       sign-out leaves behind — token blanked, row kept, credential still in
       the keychain — is byte-identical to a legitimately remembered one, so
       no code can tell them apart, and the silent sign-in was reachable from
       the shipping build. Everybody signs in once on upgrade instead. */
    disk.set(KEY, JSON.stringify([server({ token: "" })]));
    shell.bridge.secrets.get.mockResolvedValue(held(TOKEN));
    const S = await fresh();
    await S.hydrate();

    expect(S.servers()[0]?.token).toBe("");
    // And the row stops being ambiguous.
    expect(rowFor()?.kept).toBe(false);
    // The address is kept; it is a password that is being asked for.
    expect(S.servers()[0]?.url).toBe("https://ft.acme.example");
  });

  it("is not granted by what an old failed sign-out left, which looks the same", async () => {
    // Exactly the state `a75f92d3`'s `signedOut()` produced when its keychain
    // deletion was refused.
    disk.set(KEY, JSON.stringify([server({ token: "" })]));
    shell.bridge.secrets.get.mockResolvedValue(held("token_the_person_declined"));
    const S = await fresh();
    await S.hydrate();

    expect(S.servers()[0]?.token).toBe("");
  });

  it("is withdrawn when the keychain says the credential has gone", async () => {
    disk.set(KEY, JSON.stringify([server({ token: "", kept: true })]));
    shell.bridge.secrets.get.mockResolvedValue(absent);
    const S = await fresh();
    await S.hydrate();

    expect(S.servers()[0]?.token).toBe("");
    expect(rowFor()?.kept).toBe(false);
  });
});

/**
 * **D1.** A keychain read that failed is not a keychain with nothing in it.
 *
 * `keyring` answers `NoEntry` for exactly one situation and treats every other
 * outcome as an error — no Secret Service on the bus, a locked login keyring,
 * a macOS keychain that will not grant access, a Credential Manager a policy
 * has closed. A `.catch(() => null)` turned all of those into "there is no
 * credential here", which was permission to forget that somebody had signed
 * out. QA drove the whole chain on the installed `.deb`: one launch on a
 * machine with no keyring, and the launch after it signed straight into the
 * dashboard with the token the person had declined.
 */
describe("a keychain read that could not be answered", () => {
  it("changes nothing at all", async () => {
    disk.set(KEY, JSON.stringify([server({ token: "", kept: true })]));
    shell.bridge.secrets.get.mockResolvedValue(unknown());
    const S = await fresh();
    await S.hydrate();

    // No session…
    expect(S.servers()[0]?.token).toBe("");
    // …and no permission spent either: the next launch asks properly.
    expect(rowFor()?.kept).toBe(true);
    expect(S.unkeptSignIn()).toBe(null);
  });

  it("does not lift a sign-out, however many launches it takes", async () => {
    /* The chain QA drove, step for step. */
    // 1. A keyring that works. Signed in, and the keychain is holding A.
    const S = await fresh();
    S.remember(server({ token: "token_A" }) as never);
    await settle();
    expect(rowFor()?.kept).toBe(true);

    // 2. The keyring goes away. Signing in again cannot be stored; Back.
    refuse();
    shell.bridge.secrets.delete.mockResolvedValue(refusedBy());
    S.remember(server({ token: "token_B" }) as never);
    await settle();
    S.unkeptSaid();
    S.signedOut("s_acme");
    await settle();
    expect(rowFor()?.kept).toBe(false);

    // 3. **One launch with no Secret Service at all.** This is the step that
    //    used to clear the protection.
    shell.bridge.secrets.get.mockResolvedValue(unknown());
    const blind = await fresh();
    await blind.hydrate();
    expect(rowFor()?.kept).toBe(false);

    // 4. The keyring is back, unlocked, and still holding A.
    shell.bridge.secrets.get.mockResolvedValue(held("token_A"));
    shell.bridge.secrets.delete.mockResolvedValue(done);
    const next = await fresh();
    await next.hydrate();

    // Not signed in, and the declined credential is taken out now it can be.
    expect(next.servers()[0]?.token).toBe("");
    expect(shell.bridge.secrets.delete).toHaveBeenCalledWith("s_acme");
  });

  it("does not move an old build's token into a keychain that might hold one", async () => {
    /* A legacy row where the read failed: whether something is stored is not
       the question, so the store is attempted and its answer decides. Here it
       works, so the sign-in is kept rather than ended. */
    disk.set(KEY, JSON.stringify([server()]));
    shell.bridge.secrets.get.mockResolvedValue(unknown());
    const S = await fresh();
    await S.hydrate();

    expect(S.servers()[0]?.token).toBe(TOKEN);
    expect(rowFor()?.kept).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
});

/**
 * **D2.** A hydration snapshot must not land on top of a newer sign-in.
 *
 * The era was read when the loop *reached* a row, so an action taken on a
 * later server before the loop got there had already incremented it — and the
 * stale row then passed its own check. QA signed into the second server while
 * the first was blocking and watched the session end seconds later.
 */
describe("a hydration that is overtaken", () => {
  const two = [
    server({ serverId: "o_1", url: "https://x.example", token: "", kept: true }),
    server({ serverId: "o_2", url: "https://y.example", token: "", kept: true }),
  ];

  it("does not undo a sign-in made to a later server while it was blocked", async () => {
    disk.set(KEY, JSON.stringify(two));
    let answerX: (v: unknown) => void = () => {};
    shell.bridge.secrets.get.mockImplementation((id: string) =>
      id === "o_1" ? new Promise((r) => (answerX = r)) : Promise.resolve(held("y_old")),
    );

    const S = await fresh();
    const hydrating = S.hydrate();
    await settle();

    // The body has opened and the person signs into Y. It works.
    S.remember(server({ serverId: "o_2", url: "https://y.example", token: "y_new" }) as never);
    await settle();
    expect(S.servers().find((s) => s.serverId === "o_2")?.token).toBe("y_new");

    // X finally answers, and hydration walks on to the row it snapshotted.
    answerX(held("x_token"));
    await hydrating;

    expect(S.servers().find((s) => s.serverId === "o_2")?.token).toBe("y_new");
    expect(S.unkeptSignIn()).toBe(null);
  });

  it("does not end a later server's legacy sign-in it has already replaced", async () => {
    /* The same shape with the migration on the end of it, which is what QA
       actually drove: the stale row still carried Y's old plaintext token, so
       the overtaken pass revoked it and threw the person back to the door. */
    disk.set(
      KEY,
      JSON.stringify([
        server({ serverId: "o_1", url: "https://x.example", token: "x_legacy" }),
        server({ serverId: "o_2", url: "https://y.example", token: "y_legacy" }),
      ]),
    );
    let answerX: (v: unknown) => void = () => {};
    shell.bridge.secrets.get.mockImplementation((id: string) =>
      id === "o_1" ? new Promise((r) => (answerX = r)) : Promise.resolve(absent),
    );
    refuse();

    const S = await fresh();
    const hydrating = S.hydrate();
    await settle();

    S.remember(server({ serverId: "o_2", url: "https://y.example", token: "y_new" }) as never);
    await settle();
    S.unkeptSaid();

    answerX(absent);
    await hydrating;

    // Y's session is the one the person made, and nothing revoked it.
    expect(S.servers().find((s) => s.serverId === "o_2")?.token).toBe("y_new");
    expect(S.unkeptSignIn()?.serverId).not.toBe("o_2");
    const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.map((c) => c[0])).not.toContain("https://y.example/api/v1/auth/logout");
  });

  it("does not restore a credential for a server forgotten and re-added", async () => {
    // Same `serverId`, a different registration. `addedAt` is what tells them
    // apart, and the snapshot has to notice.
    disk.set(KEY, JSON.stringify([server({ token: "", kept: true })]));
    let answer: (v: unknown) => void = () => {};
    shell.bridge.secrets.get.mockReturnValue(new Promise((r) => (answer = r)));

    const S = await fresh();
    const hydrating = S.hydrate();
    await settle();

    S.forget("s_acme");
    S.remember(server({ token: "fresh", addedAt: "2026-11-12T10:00:00.000Z" }) as never);
    await settle();

    answer(held("the_old_one"));
    await hydrating;

    expect(S.servers()[0]?.token).toBe("fresh");
  });
});

/**
 * **D3.** A sign-out that could not be recorded is said out loud.
 *
 * Two independent things make a sign-out stick: taking the credential out of
 * the keychain, and recording that the row does not permit a restore. The
 * second used to swallow its own failure, on the reasoning that a window with
 * no storage keeps no credential either — which is not so when the credential
 * is in the OS keychain. Either one working is enough; both failing is the
 * state that cannot be made safe from in here, so it is reported.
 */
describe("a sign-out this machine could not make stick", () => {
  it("is silent when the credential was deleted, whatever the registry did", async () => {
    const S = await fresh();
    S.remember(server({ token: "token_A" }) as never);
    await settle();

    unwritable.add(KEY);
    S.signedOut("s_acme");
    await settle();

    // The deletion went through, so there is nothing left to restore.
    expect(shell.bridge.secrets.delete).toHaveBeenCalledWith("s_acme");
    expect(S.unkeptSignIn()).toBe(null);
  });

  it("is silent when the registry recorded it, whatever the keychain did", async () => {
    const S = await fresh();
    S.remember(server({ token: "token_A" }) as never);
    await settle();

    shell.bridge.secrets.delete.mockResolvedValue(refusedBy("keyring is locked"));
    S.signedOut("s_acme");
    await settle();

    expect(rowFor()?.kept).toBe(false);
    expect(S.unkeptSignIn()).toBe(null);

    // And the next launch refuses what is still in the keychain.
    shell.bridge.secrets.get.mockResolvedValue(held("token_A"));
    const next = await fresh();
    await next.hydrate();
    expect(next.servers()[0]?.token).toBe("");
  });

  it("tells the person when neither of them did", async () => {
    const S = await fresh();
    S.remember(server({ token: "token_A" }) as never);
    await settle();

    unwritable.add(KEY);
    shell.bridge.secrets.delete.mockResolvedValue(refusedBy("keyring is locked"));
    S.signedOut("s_acme");
    await settle();

    expect(S.unkeptSignIn()).toEqual({ serverId: "s_acme", because: "signOut" });
  });

  it("reads a refusal list it cannot parse as refusing, not as permitting", async () => {
    // The marker this replaced, left unreadable. The reading that signs
    // somebody in is not the one to take on a guess.
    disk.set(KEY, JSON.stringify([server({ token: "", kept: true })]));
    disk.set(OUT_KEY, "{not json");
    shell.bridge.secrets.get.mockResolvedValue(held("token_A"));

    const S = await fresh();
    await S.hydrate();
    expect(S.servers()[0]?.token).toBe("");
  });

  it("honours the marker it replaced, once, and then removes it", async () => {
    disk.set(KEY, JSON.stringify([server({ token: "", kept: true })]));
    disk.set(OUT_KEY, JSON.stringify(["s_acme"]));
    shell.bridge.secrets.get.mockResolvedValue(held("token_A"));

    const S = await fresh();
    await S.hydrate();

    expect(S.servers()[0]?.token).toBe("");
    expect(rowFor()?.kept).toBe(false);
    expect(disk.get(OUT_KEY)).toBeUndefined();
  });
});

/**
 * **D4 and B4.** A revocation that did not happen is not announced as one.
 *
 * `endLegacy` awaited the logout and looked at nothing it answered: a 500 did
 * not throw, an offline machine was caught and discarded, and there was no
 * deadline — so the card said the session had been ended on all three, while
 * the token still answered 200 and its bytes were still readable in a `0644`
 * file. And because the registry was blanked only in `hydrate`'s `finally`, a
 * hanging logout kept that plaintext in the file past the point where the body
 * had opened.
 */
describe("ending an old build's sign-in", () => {
  const legacyOnly = () => {
    disk.set(KEY, JSON.stringify([server()]));
    refuse();
  };

  it("says so, and says the server confirmed it, when it did", async () => {
    legacyOnly();
    const S = await fresh();
    await S.hydrate();
    await settle();

    expect(S.unkeptSignIn()).toEqual({ serverId: "s_acme", because: "legacy", revoked: "confirmed" });
    expect(S.servers()[0]?.token).toBe("");
    expect(S.unconfirmedRevocations()).toEqual([]);
  });

  it("does not claim an ending the server refused", async () => {
    legacyOnly();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const S = await fresh();
    await S.hydrate();
    await settle();

    expect(S.unkeptSignIn()).toEqual({ serverId: "s_acme", because: "legacy", revoked: "unconfirmed" });
    expect(S.unconfirmedRevocations()).toEqual(["s_acme"]);
  });

  it("does not claim an ending it could not even ask for", async () => {
    legacyOnly();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const S = await fresh();
    await S.hydrate();
    await settle();

    expect(S.unkeptSignIn()).toEqual({ serverId: "s_acme", because: "legacy", revoked: "unconfirmed" });
  });

  it("asks with a deadline, so a hanging logout is not a pending one forever", async () => {
    legacyOnly();
    const S = await fresh();
    await S.hydrate();
    await settle();

    const [, init] = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.method).toBe("POST");
  });

  it("keeps trying while the window is open, always with the original token", async () => {
    vi.useFakeTimers();
    try {
      legacyOnly();
      const asked = vi.fn().mockResolvedValue({ ok: false, status: 503 });
      vi.stubGlobal("fetch", asked);

      const S = await fresh();
      await S.hydrate();
      await vi.advanceTimersByTimeAsync(0);
      expect(S.unconfirmedRevocations()).toEqual(["s_acme"]);

      // The server comes back. The next attempt is the one that lands.
      asked.mockResolvedValue({ ok: true, status: 204 });
      await vi.advanceTimersByTimeAsync(61_000);

      expect(S.unconfirmedRevocations()).toEqual([]);
      expect(S.unkeptSignIn()).toEqual({ serverId: "s_acme", because: "legacy", revoked: "confirmed" });
      // Every attempt carried the credential it was opened for.
      for (const [, init] of asked.mock.calls as [string, RequestInit][]) {
        expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("takes the plaintext out of the file before it waits for anything", async () => {
    /* **B4's testable half.** The bytes an older build wrote are in the
       SQLite pages WebKit keeps `localStorage` in, and nothing in a webview
       can scrub those — that is QA's measurement to make on the installed
       build, and it is why the answer to the exposure is revocation rather
       than deletion. What is asserted here is the part this module owns: the
       value it keeps carries no token from the first moment, even while both
       the keychain and the network are still outstanding. */
    disk.set(KEY, JSON.stringify([server()]));
    let storing: (v: unknown) => void = () => {};
    shell.bridge.secrets.get.mockResolvedValue(absent);
    shell.bridge.secrets.set.mockReturnValue(new Promise((r) => (storing = r)));
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(new Promise(() => {})));

    const S = await fresh();
    const hydrating = S.hydrate();
    await settle();

    // The keychain write has not answered and no logout ever will.
    expect(onDisk()).not.toContain(TOKEN);
    expect(everything()).not.toContain(TOKEN);

    storing(refusedBy());
    await hydrating;
    await settle();

    expect(everything()).not.toContain(TOKEN);
    // Still not claiming anything was ended.
    expect(S.unkeptSignIn()).toEqual({ serverId: "s_acme", because: "legacy", revoked: "unconfirmed" });
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
});

/**
 * The constraint the whole of this module exists under, re-asked of every path
 * that changed.
 *
 * A security review fixed it and QA proved it on a real disk twice: the
 * sign-in token goes nowhere but process memory, and a search of 3,880 files
 * in four encodings — with a positive control — found none of it.
 */
describe("nothing a token is in ever reaches the disk", () => {
  it("not through a sign-in, a sign-out, a refusal or a relaunch", async () => {
    const S = await fresh();
    await S.hydrate();

    S.remember(server({ token: "token_A" }) as never);
    await settle();
    expect(everything()).not.toContain("token_A");

    refuse();
    S.remember(server({ token: "token_B" }) as never);
    await settle();
    expect(everything()).not.toContain("token_B");

    S.signedOut("s_acme");
    await settle();
    expect(everything()).not.toContain("token_A");
    expect(everything()).not.toContain("token_B");

    shell.bridge.secrets.get.mockResolvedValue(held("token_A"));
    const next = await fresh();
    await next.hydrate();
    expect(everything()).not.toContain("token_A");
  });

  it("not in the row's own permission bit, which is a boolean", async () => {
    const S = await fresh();
    S.remember(server() as never);
    await settle();
    expect(rowFor()?.kept).toBe(true);
    expect(everything()).not.toContain(TOKEN);
  });

  it("not while a revocation is pending, which holds one in memory", async () => {
    disk.set(KEY, JSON.stringify([server()]));
    refuse();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    const S = await fresh();
    await S.hydrate();
    await settle();

    expect(S.unconfirmedRevocations()).toEqual(["s_acme"]);
    expect(everything()).not.toContain(TOKEN);
  });
});

/**
 * **Bug 1.** A sign-in has to reach the app, not only the card.
 *
 * The headline flow of the Linux tier: a machine with no OS keychain. The
 * sign-in succeeded, the mock recorded authenticated requests — and the window
 * stayed on the password field with a card over it saying *"You are signed in
 * now"*. `remember()` writes the row before attempting the store, which is
 * right and has to stay: the row must never claim a permission nothing has
 * granted, and the legacy plaintext has to leave the file before anything is
 * awaited. What was missing is that `keep()` put the token in memory and told
 * nobody, so the only `changed()` anyone heard was the one fired *before* it.
 */
describe("a sign-in on a machine with no keychain", () => {
  /** What the window has been told, as it would hold it. */
  const watching = (S: Awaited<ReturnType<typeof fresh>>) => {
    let seen = S.servers();
    S.onServers(() => (seen = S.servers()));
    return () => seen;
  };

  it("reaches the app, and the card is over the app rather than the door", async () => {
    refuse();
    const S = await fresh();
    await S.hydrate();
    const window$ = watching(S);

    S.remember(server() as never);
    await settle();

    // The window has been told about the session, not only about the refusal.
    expect(window$()[0]?.token).toBe(TOKEN);
    expect(S.unkeptSignIn()).toEqual({ serverId: "s_acme", because: "signIn", stale: false });
    // And nothing was written anywhere for it.
    expect(everything()).not.toContain(TOKEN);
  });

  it("reaches the app when the keychain works, too", async () => {
    const S = await fresh();
    await S.hydrate();
    const window$ = watching(S);

    S.remember(server() as never);
    await settle();

    expect(window$()[0]?.token).toBe(TOKEN);
    expect(window$()[0]?.kept).toBe(true);
  });

  it("tells the window before it tells the card, so the card is never alone", async () => {
    /* The ordering the bug was: `changed()` fired once, with no token, and
       the next thing to fire was the card's own watcher. */
    refuse();
    const S = await fresh();
    await S.hydrate();

    const order: string[] = [];
    S.onServers(() => order.push(`servers:${S.servers()[0]?.token || "none"}`));
    S.onUnkept(() => order.push("card"));

    S.remember(server() as never);
    await settle();

    expect(order).toContain(`servers:${TOKEN}`);
    expect(order.indexOf(`servers:${TOKEN}`)).toBeLessThan(order.indexOf("card"));
  });
});

/**
 * **R1.** A refusal that could not be written down is still a refusal.
 *
 * `retireMarker()` turned the old `firetower.signedOut` list into `kept:
 * false` and then removed the key — ignoring whether the write had gone. A
 * quota failure while *adding* a field followed by a removal that frees space
 * is an ordinary storage sequence, and it erased the only record of a refusal
 * in the very launch that then signed back in.
 */
describe("retiring the old refusal marker", () => {
  const signedOutOnTheOldBuild = () => {
    disk.set(KEY, JSON.stringify([server({ token: "", kept: true })]));
    disk.set(OUT_KEY, JSON.stringify(["s_acme"]));
    shell.bridge.secrets.get.mockResolvedValue(held("token_A"));
  };

  it("keeps the marker, and refuses anyway, when the replacement will not write", async () => {
    signedOutOnTheOldBuild();
    unwritable.add(KEY);

    const S = await fresh();
    await S.hydrate();

    // Not signed in, which is the whole point.
    expect(S.servers()[0]?.token).toBe("");
    // The marker is still there, because it is the only record there is.
    expect(JSON.parse(disk.get(OUT_KEY) ?? "[]")).toEqual(["s_acme"]);
  });

  it("and the next launch, which can write, records it properly", async () => {
    signedOutOnTheOldBuild();
    unwritable.add(KEY);
    const blocked = await fresh();
    await blocked.hydrate();

    unwritable.clear();
    const S = await fresh();
    await S.hydrate();

    expect(S.servers()[0]?.token).toBe("");
    expect(rowFor()?.kept).toBe(false);
    expect(disk.get(OUT_KEY)).toBeUndefined();
  });
});

/**
 * **R2.** Replacement and disconnect have to read their own writes too.
 *
 * `signedOut()` learned this; the other two mutation paths had not. A positive
 * permission bit that could not be set to false is still true, and the card
 * went on promising a password field at the next launch while an older
 * credential sat in the keychain waiting to answer for it.
 */
describe("a replacement or a disconnect that could not be recorded", () => {
  const signedInProperly = async () => {
    const S = await fresh();
    S.remember(server({ token: "token_A" }) as never);
    await settle();
    expect(rowFor()?.kept).toBe(true);
    return S;
  };

  it("does not promise a password field it cannot deliver", async () => {
    const S = await signedInProperly();

    // The replacement: the registry will not take the denial and the keychain
    // will not take the new token.
    unwritable.add(KEY);
    refuse();
    S.remember(server({ token: "token_B" }) as never);
    await settle();

    expect(S.unkeptSignIn()).toEqual({ serverId: "s_acme", because: "signIn", stale: true });
    expect(S.servers()[0]?.token).toBe("token_B");
  });

  it("says the ordinary thing when the denial did go down", async () => {
    const S = await signedInProperly();
    refuse();
    S.remember(server({ token: "token_B" }) as never);
    await settle();

    expect(S.unkeptSignIn()).toEqual({ serverId: "s_acme", because: "signIn", stale: false });
    expect(rowFor()?.kept).toBe(false);
  });

  it("falls back to denying the row when it cannot remove it", async () => {
    const S = await signedInProperly();
    /* Removal is the better outcome and is tried first; a row that stays but
       grants nothing is the next best thing. */
    let refusedOnce = false;
    const held$ = disk.set.bind(disk);
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (k: string) => disk.get(k) ?? null,
        setItem: (k: string, v: string) => {
          // Only the removal: the shorter denial write is allowed through.
          if (k === KEY && JSON.parse(v).length === 0 && !refusedOnce) {
            refusedOnce = true;
            throw new Error("QuotaExceededError");
          }
          held$(k, v);
        },
        removeItem: (k: string) => void disk.delete(k),
      },
    });
    shell.bridge.secrets.delete.mockResolvedValue(refusedBy("keyring is locked"));

    S.forget("s_acme");
    await settle();

    expect(refusedOnce).toBe(true);
    expect(rowFor()?.kept).toBe(false);
    // Recorded, so nothing is owed to the person.
    expect(S.unkeptSignIn()).toBe(null);
  });

  it("owns up to a disconnect that neither store would take", async () => {
    const S = await signedInProperly();
    unwritable.add(KEY);
    shell.bridge.secrets.delete.mockResolvedValue(refusedBy("keyring is locked"));

    S.forget("s_acme");
    await settle();

    expect(S.unkeptSignIn()).toEqual({ serverId: "s_acme", because: "signOut" });
  });

  it("is silent about a disconnect whose credential was actually deleted", async () => {
    const S = await signedInProperly();
    unwritable.add(KEY);

    S.forget("s_acme");
    await settle();

    expect(shell.bridge.secrets.delete).toHaveBeenCalledWith("s_acme");
    expect(S.unkeptSignIn()).toBe(null);
  });
});

/**
 * **R4.** A login page is a 200, and it is not a revocation.
 *
 * An authentication proxy answering `302 /login` is enough: `fetch` follows
 * the redirect, turns the POST into a GET, and hands back a perfectly good
 * `200` with somebody else's HTML in it. `answer.ok` was true, the pending
 * revocation was cleared, and the card told the person the copy in that file
 * was no good to anybody while the logout handler had never run.
 */
describe("what counts as a revocation", () => {
  const legacyOnly = () => {
    disk.set(KEY, JSON.stringify([server()]));
    refuse();
  };

  it("is the one status the endpoint documents, and nothing else", async () => {
    legacyOnly();
    // What a proxy's login page looks like once `fetch` has followed it.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, redirected: true }));
    const S = await fresh();
    await S.hydrate();
    await settle();

    expect(S.unkeptSignIn()).toEqual({ serverId: "s_acme", because: "legacy", revoked: "unconfirmed" });
    expect(S.unconfirmedRevocations()).toEqual(["s_acme"]);
  });

  it("refuses to follow the redirect at all", async () => {
    legacyOnly();
    const S = await fresh();
    await S.hydrate();
    await settle();

    const [, init] = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(init.redirect).toBe("error");
  });

  it("still confirms the answer the endpoint really gives", async () => {
    legacyOnly();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 204 }));
    const S = await fresh();
    await S.hydrate();
    await settle();

    expect(S.unkeptSignIn()).toEqual({ serverId: "s_acme", because: "legacy", revoked: "confirmed" });
  });

  it("does not store a legacy token over a newer one the keychain already has", async () => {
    /* A plaintext copy in the file and a credential already in the keychain:
       the copy is superseded, so storing it would overwrite something newer.
       It is ended instead, and the row still grants nothing. */
    disk.set(KEY, JSON.stringify([server()]));
    shell.bridge.secrets.get.mockResolvedValue(held("newer_token"));
    const S = await fresh();
    await S.hydrate();
    await settle();

    expect(shell.bridge.secrets.set).not.toHaveBeenCalled();
    expect(S.servers()[0]?.token).toBe("");
    expect(S.unkeptSignIn()?.because).toBe("legacy");
  });
});

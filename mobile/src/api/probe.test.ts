import { afterEach, describe, expect, it, vi } from "vitest";
import { signIn } from "./probe";

/**
 * A temporary password is accepted and then refuses everything.
 *
 * The server answers 200 with a token for a password that has to be replaced,
 * and then refuses every path but four until it is. So the only thing standing
 * between that and an app full of "could not reach the control plane" is this
 * field being carried out of the sign-in rather than dropped — which is
 * exactly what used to happen, on the phone, where nothing read it at all.
 */
describe("signIn", () => {
  afterEach(() => vi.unstubAllGlobals());

  const answering = (user: Record<string, unknown>) =>
    vi.fn(async () =>
      new Response(JSON.stringify({ token: "t_1", user }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

  it("carries out that the password it just accepted has to be replaced", async () => {
    vi.stubGlobal("fetch", answering({ username: "bob", mustChangePassword: true }));
    expect(await signIn("https://ft", "bob", "temporary")).toEqual({
      ok: true,
      token: "t_1",
      user: "bob",
      mustChangePassword: true,
    });
  });

  it("says no for an ordinary password, rather than leaving it undefined", async () => {
    vi.stubGlobal("fetch", answering({ username: "bob", mustChangePassword: false }));
    expect(await signIn("https://ft", "bob", "their own")).toMatchObject({
      ok: true,
      mustChangePassword: false,
    });
  });

  // A server from before the field existed, and a client that must not read
  // the absence of it as "blocked" — which would lock every account out.
  it("treats a server that does not mention it as nothing to do", async () => {
    vi.stubGlobal("fetch", answering({ username: "bob" }));
    expect(await signIn("https://ft", "bob", "their own")).toMatchObject({
      ok: true,
      mustChangePassword: false,
    });
  });

  it("is not ok when the password was wrong", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ code: "Unauthorized", message: "no" }), { status: 401 }),
      ),
    );
    expect(await signIn("https://ft", "bob", "wrong")).toMatchObject({ ok: false, why: "no" });
  });
});

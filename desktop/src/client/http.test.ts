/**
 * The mutator, asked the one question it used to have no answer to.
 *
 * A token that stops working is the ordinary case, not the exotic one: a
 * password replaced in a browser ends every other session, an administrator
 * can reset one, another device can sign out. The server says `Unauthorized`
 * to everything from then on, and for a while nothing here read that — every
 * screen rendered "sign in to use this Firetower" in its own corner while the
 * app went on drawing a dashboard around them, with no way back to a password
 * field short of forgetting the server and typing its address again.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const signedOut = vi.fn();
vi.mock("~/servers", () => ({
  servers: () => [
    { url: "https://ft", serverId: "o_1", org: "Kev", user: "kev", token: "t_1", addedAt: "" },
  ],
  signedOut,
}));

const { http, meansSignedOut, useBackendId } = await import("./http");
useBackendId("o_1");

const refusing = (status: number, code: string) =>
  vi.fn(async () =>
    new Response(JSON.stringify({ code, message: "no" }), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );

afterEach(() => {
  vi.unstubAllGlobals();
  signedOut.mockClear();
});

describe("a refusal that means the session is over", () => {
  it("says so about the server it was talking to", async () => {
    vi.stubGlobal("fetch", refusing(401, "Unauthorized"));
    await expect(http("/api/v1/sessions")).rejects.toThrow();
    expect(signedOut).toHaveBeenCalledWith("o_1");
  });

  /* Being told no about one thing is not a session ending. On the web that
     exact confusion signed people out at random while they typed: a repository
     the token could not see answered the same way as an expired session. */
  it("is not being refused one thing", async () => {
    vi.stubGlobal("fetch", refusing(403, "Forbidden"));
    await expect(http("/api/v1/repos/x")).rejects.toThrow();
    expect(signedOut).not.toHaveBeenCalled();
  });

  it("is not a password that still has to be replaced", async () => {
    vi.stubGlobal("fetch", refusing(403, "PasswordChangeRequired"));
    await expect(http("/api/v1/sessions")).rejects.toThrow();
    expect(signedOut).not.toHaveBeenCalled();
  });

  it("is not the server having a bad day", async () => {
    vi.stubGlobal("fetch", refusing(500, "Internal"));
    await expect(http("/api/v1/sessions")).rejects.toThrow();
    expect(signedOut).not.toHaveBeenCalled();
  });

  it("leaves a request that worked alone", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    expect(await http("/api/v1/sessions")).toEqual({ ok: true });
    expect(signedOut).not.toHaveBeenCalled();
  });
});

describe("meansSignedOut", () => {
  it("is only Unauthorized", () => {
    expect(meansSignedOut("Unauthorized")).toBe(true);
    for (const code of ["Forbidden", "PasswordChangeRequired", "NotFound", "Internal", "InvalidRequest"]) {
      expect(meansSignedOut(code)).toBe(false);
    }
  });
});

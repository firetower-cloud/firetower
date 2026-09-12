/**
 * Finding out whether there is a Firetower at an address, and what it is.
 *
 * `GET /api/v1/bootstrap` is unauthenticated and cheap, which is what makes it
 * the right first move: the client can name the organisation, the version and
 * how to sign in **before** it asks anybody for a password. Typing the address
 * of the wrong company's Firetower should be caught by reading its name, not by
 * handing it your credentials and seeing what happens.
 */
export type Bootstrap = {
  version: string;
  eventsPath: string;
  serverId?: string | null;
  organization?: string | null;
  authModes: string[];
};

export type Reached =
  | { ok: true; url: string; at: Bootstrap }
  | { ok: false; why: "unreachable" | "not-firetower"; detail: string };

/**
 * What somebody typed, as a URL.
 *
 * A bare host is the common case — `ft-e1.tail9c2b.ts.net` is what Tailscale
 * shows you — so a scheme is added rather than demanded. `https` first, because
 * anything reachable over a mesh is usually behind a proxy that has a
 * certificate, and `http` after, because a laptop install is not.
 */
export function candidates(typed: string): string[] {
  const raw = typed.trim().replace(/\/+$/, "");
  if (!raw) return [];
  if (/^https?:\/\//i.test(raw)) return [raw];
  // A port on its own means a local install, which is never https.
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(raw)) return [`http://${raw}`];
  return [`https://${raw}`, `http://${raw}`];
}

async function ask(url: string, signal: AbortSignal): Promise<Reached> {
  let res: Response;
  try {
    res = await fetch(`${url}/api/v1/bootstrap`, { signal, redirect: "follow" });
  } catch (e) {
    return { ok: false, why: "unreachable", detail: String((e as Error)?.message ?? e) };
  }

  if (!res.ok) {
    return { ok: false, why: "not-firetower", detail: `answered ${res.status}` };
  }

  try {
    const at = (await res.json()) as Bootstrap;
    // Something answered; whether it is a Firetower is a different question.
    if (typeof at.version !== "string" || !Array.isArray(at.authModes)) {
      return { ok: false, why: "not-firetower", detail: "that is not a Firetower" };
    }
    return { ok: true, url, at };
  } catch {
    return { ok: false, why: "not-firetower", detail: "that is not a Firetower" };
  }
}

/** Tries each candidate in turn and keeps the first that answers. */
export async function reach(typed: string, ms = 6000): Promise<Reached> {
  const tries = candidates(typed);
  if (tries.length === 0) {
    return { ok: false, why: "not-firetower", detail: "nothing typed" };
  }

  let last: Reached = { ok: false, why: "unreachable", detail: "nothing tried" };
  for (const url of tries) {
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), ms);
    try {
      const answer = await ask(url, stop.signal);
      if (answer.ok) return answer;
      last = answer;
      // A wrong scheme is worth retrying; a wrong server is not.
      if (answer.why === "not-firetower") return answer;
    } finally {
      clearTimeout(timer);
    }
  }
  return last;
}

/** Signs in with a password, against the endpoint that already exists. */
export async function signIn(
  url: string,
  username: string,
  password: string,
): Promise<{ ok: true; token: string; user: string } | { ok: false; why: string }> {
  let res: Response;
  try {
    res = await fetch(`${url}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
  } catch (e) {
    return { ok: false, why: String((e as Error)?.message ?? e) };
  }

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    return { ok: false, why: body?.message ?? `signing in failed (${res.status})` };
  }
  const token = body?.token ?? body?.session?.token;
  if (!token) return { ok: false, why: "no token came back" };

  return { ok: true, token, user: body?.user?.username ?? username };
}

/**
 * Which server the live script is allowed to write to.
 *
 * `cursor-live.mjs` stopped only reading: it clears the first administrator's
 * forced password change and it names an organisation. A harness that writes
 * has to be told its target and has to check the one it was told, so the two
 * rules that settle it live here rather than inline — apart from the three
 * hundred lines that drive a browser, and testable without one.
 */

/**
 * A loopback host, spelled the way `desktop/src/probe.ts` spells it.
 *
 * The same three names the app treats as a local install, because the whole
 * point of asking is to agree with it about which addresses are this machine.
 */
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])$/i;

/**
 * The one origin to look for the control plane at.
 *
 * `probe.ts` tries https for a bare hostname and then http, which is right
 * for the app: a laptop install has no certificate, and the next thing that
 * happens is a person reading the name of whatever answered. This harness has
 * no reader and the next thing it does is post an administrator's password,
 * so there is no fallback here — http is refused anywhere but loopback, and
 * an on-path answerer cannot be handed the credential by blocking https.
 *
 * One address rather than a list, for the same reason: a harness that writes
 * should fail with the name of the thing it could not reach instead of
 * quietly trying somewhere else.
 */
export function origin(typed) {
  const said = (typed ?? "").trim();
  if (!said) throw new Error("Set FIRETOWER_E2E_SERVER to the isolated server's address");

  // The scheme is read before the trailing slashes come off, so that a scheme
  // and nothing else is an address nobody typed rather than a hostname.
  const scheme = /^([a-z][a-z0-9+.\-]*):\/\//i.exec(said)?.[1].toLowerCase();
  const raw = said.replace(/\/+$/, "");
  if (scheme && scheme !== "http" && scheme !== "https") {
    throw new Error(`FIRETOWER_E2E_SERVER: nothing a Firetower answers on is ${scheme}://`);
  }

  let host;
  try {
    host = new URL(scheme ? raw : `https://${raw}`).hostname;
  } catch {
    throw new Error(`FIRETOWER_E2E_SERVER: ${raw} is not an address`);
  }
  const here = LOOPBACK.test(host);

  if (scheme === "http" && !here) {
    throw new Error(
      `FIRETOWER_E2E_SERVER: ${raw} is http and ${host} is not this machine — this run posts an ` +
        "administrator's password and will not put one on the wire in clear. Use https.",
    );
  }
  if (scheme) return raw;
  // A port on its own means a local install, which is never https.
  return here ? `http://${raw}` : `https://${raw}`;
}

/**
 * Why this run will not write to the server that answered — or nothing.
 *
 * `GET /api/v1/bootstrap` is unauthenticated, creates nothing and costs one
 * round trip, and it carries the fact that settles this. `serverId` is the
 * organisation's id, and `api.rs` fills it in only once the organisation has
 * been **named** — `accounts.rs` reads `installation.named_at`, and being
 * named is what "set up" means. So a server with one has been set up by
 * somebody, and a server somebody has set up is not the fresh backend this
 * script drives, whatever else it is. Refusing it is what turns "I hope this
 * is the right address" into "this cannot be the developer's own Firetower",
 * because theirs has been set up and a typo's victim is almost always a
 * server in use.
 *
 * It is a necessary condition and not an identity: a second *fresh* stack
 * would pass it. What that costs is bounded — a server nobody has set up has
 * nothing in it to lose, and the explicit variable is what stops the accident
 * this backs up.
 */
export function refusal(at, where) {
  if (!at || typeof at.version !== "string" || !Array.isArray(at.authModes)) {
    return `Something answered at ${where} and it is not a Firetower`;
  }
  // Both, though one row answers both and they are never apart today: a
  // harness that is about to write should not be the thing that discovers a
  // field was withheld.
  if (at.serverId || at.organization) {
    return (
      `${where} is a Firetower somebody has already set up (${at.organization ?? at.serverId}), and ` +
      "this run replaces the first administrator's password and names the organisation — so it only " +
      "goes near a server nobody has set up. Point FIRETOWER_E2E_SERVER at a fresh one of your own."
    );
  }
  return null;
}

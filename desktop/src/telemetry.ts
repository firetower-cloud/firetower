/**
 * Carrying each server's telemetry out.
 *
 * A control plane does not call out — it is a server on somebody's private
 * network, and for a good number of installations it could not reach the
 * internet if it wanted to. So it computes a digest per completed day into an
 * outbox and waits. This is what empties it.
 *
 * ## It is a courier, not a reporter
 *
 * Nothing here decides what is in a digest, or whether there should be one.
 * The server assembles the document, says where it goes, and hands it over
 * sealed; this posts it and reports back which ones got through. Two things
 * follow from keeping it that dumb:
 *
 * * **`/telemetry/preview` is honest.** An administrator reading it sees the
 *   bytes that leave, because no client adds a field on the way past.
 * * **Turning telemetry off cannot be worked around by a stale build.** A
 *   disabled install simply has an empty outbox. There is no flag here to
 *   check and no version of this file that can ignore one.
 *
 * ## A multi-seat organisation is counted once
 *
 * Whichever desktop gets there first delivers the day and acknowledges it;
 * every other one asks and is told nothing is owed. Twelve teammates with the
 * app open send one digest between them, not twelve copies.
 *
 * ## Failure is the ordinary path
 *
 * None of this is awaited by anything that draws. A digest that does not go
 * today goes tomorrow, and an install offline for a fortnight delivers its
 * backlog when somebody next opens the app. So every failure here is silent
 * and nothing is retried in a hurry.
 *
 * The one rule worth stating: **4xx is permanent and 5xx is not.** A digest
 * the gateway will never accept — one from a schema it does not know, one
 * dated outside its window — is acknowledged anyway, because there is nothing
 * further to be done about it and the alternative is retrying it on every
 * launch forever. Anything else is left owed.
 */
import { onServers, servers, type Connected } from "~/servers";

/**
 * Six hours, and once shortly after launch.
 *
 * There is at most one digest per day to carry, so this is already far more
 * often than there is anything to do. The interval exists for the laptop that
 * stays open for a week, not to be timely.
 */
const EVERY = 6 * 60 * 60 * 1000;

/** Long enough after launch to be behind signing in and the first paint. */
const AFTER_START = 30_000;

type Pending = { day: string; payload: unknown };
type Outbox = { endpoint: string; digests: Pending[] };

/** What became of one digest. */
type Carried = "delivered" | "refused" | "later";

/**
 * This build's version, reported so the digest can say which desktops are in
 * use.
 *
 * Asked once and remembered. Absent in a browser tab, where there is no Tauri
 * to ask and no installed version to report — the control plane treats a
 * missing courier as unknown rather than as an error.
 */
let version: string | undefined;
let asked = false;

async function courier(): Promise<string | undefined> {
  if (asked) return version;
  asked = true;
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    version = await getVersion();
  } catch {
    /* A browser build. Nothing to report, which is a fact and not a failure. */
  }
  return version;
}

async function post(endpoint: string, payload: unknown): Promise<Carried> {
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) return "delivered";
    // 429 and 408 are in the 4xx range and mean the opposite of the rest of
    // it: come back later. Neither can come from the gateway, which does no
    // rate limiting, but Cloud Run and anything between here and it can emit
    // both — and treating "slow down" as "never" would drop a digest for good.
    if (res.status === 429 || res.status === 408) return "later";
    // Permanent: the gateway will answer the same way however many times this
    // is sent. Acknowledged rather than retried until the end of time.
    if (res.status >= 400 && res.status < 500) return "refused";
    // Transient. Leave it owed.
    return "later";
  } catch {
    // No network, DNS, a proxy, a certificate. All "not now".
    return "later";
  }
}

async function carry(s: Connected) {
  const auth = { authorization: `Bearer ${s.token}` };

  let outbox: Outbox;
  try {
    const mine = await courier();
    const url = new URL(`${s.url}/api/v1/telemetry/pending`);
    if (mine) url.searchParams.set("courier", mine);
    const res = await fetch(url, { headers: auth });
    // An older control plane has no such route. Nothing to do and nothing
    // worth saying: this build talks to several servers and they upgrade on
    // their own schedules.
    if (!res.ok) return;
    outbox = (await res.json()) as Outbox;
  } catch {
    return;
  }

  if (!outbox.digests?.length) return;

  // Oldest first, as the server returns them, and stopping at the first
  // transient failure. The backlog is then always a contiguous tail rather
  // than a sequence with holes in it, and a gateway that is down is asked once
  // rather than fourteen times.
  const settled: string[] = [];
  for (const digest of outbox.digests) {
    const went = await post(outbox.endpoint, digest.payload);
    if (went === "later") break;
    settled.push(digest.day);
  }

  if (!settled.length) return;

  try {
    await fetch(`${s.url}/api/v1/telemetry/delivered`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ days: settled }),
    });
  } catch {
    // The acknowledgement is the only part that can be lost without losing
    // anything: the day stays owed, goes again tomorrow, and the gateway keys
    // on (install, day) so arriving twice is an upsert rather than a double
    // count.
  }
}

let ticking: ReturnType<typeof setInterval> | undefined;

/**
 * Start carrying, once, for the lifetime of the window.
 *
 * Also runs when the set of connected servers changes, so a server added in
 * the middle of a session does not wait up to six hours to report for the
 * first time.
 */
export function startCourier(): void {
  if (ticking) return;
  const round = () => void servers().forEach((s) => void carry(s));
  const first = setTimeout(round, AFTER_START);
  ticking = setInterval(round, EVERY);
  onServers(round);
  // Nothing clears these: they live as long as the window does, and a courier
  // that stopped when some component unmounted would be a silent gap.
  void first;
}

/** For tests, which need the carrying without the clock. */
export const __test = { carry, post };

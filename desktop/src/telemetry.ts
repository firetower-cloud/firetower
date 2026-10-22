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
 * backlog when somebody next opens the app — the whole backlog, in one round:
 * `carry` empties the outbox rather than taking one batch out of it. So every
 * failure here is silent and nothing is retried in a hurry.
 *
 * The one rule worth stating: **4xx is permanent and 5xx is not.** A digest
 * the gateway will never accept — one from a schema it does not know, one
 * dated outside its window — is acknowledged anyway, because there is nothing
 * further to be done about it and the alternative is retrying it on every
 * launch forever. Anything else is left owed.
 */
import { onServers, servers, type Connected } from "~/servers";

/**
 * Hourly, and once shortly after launch.
 *
 * Paired deliberately with the control plane's sweep, which is also hourly.
 * The outbox gains at most one digest per day and it appears within an hour of
 * 00:00 UTC, so polling faster than the thing that produces the data cannot
 * make anything arrive sooner — an hour is the floor worth having as well as
 * the ceiling worth paying for.
 *
 * It was six hours, on the reasoning that there is at most one digest per day
 * to carry and six-hourly is "already far more often than there is anything to
 * do". That is true about how often there is *work*, and irrelevant to the
 * question anybody actually has, which is how long yesterday's digest sits
 * before it leaves. The answer was up to six hours, on top of up to an hour
 * waiting to be computed — so a laptop left open across midnight UTC could be
 * most of a day behind while everything was working exactly as designed.
 *
 * Shortening it is close to free. A poll with an empty outbox is one GET to a
 * server on the same network, and `note_courier` on the far side now writes
 * only when the version changes, so twenty-four polls a day cost twenty-four
 * reads rather than twenty-four writes.
 */
const EVERY = 60 * 60 * 1000;

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

/**
 * One batch, delivered and acknowledged.
 *
 * `"drained"` means the server says nothing is owed. `"more"` means a batch
 * went and there may be another behind it. `"stop"` means leave the rest for
 * the next round — either something failed transiently, or an acknowledgement
 * was lost and asking again would be handed the same days a second time.
 */
type Batch = "drained" | "more" | "stop";

async function collect(
  s: Connected,
  auth: Record<string, string>,
  already: Set<string>,
): Promise<Batch> {
  let outbox: Outbox;
  try {
    const mine = await courier();
    const url = new URL(`${s.url}/api/v1/telemetry/pending`);
    if (mine) url.searchParams.set("courier", mine);
    const res = await fetch(url, { headers: auth });
    // An older control plane has no such route. Nothing to do and nothing
    // worth saying: this build talks to several servers and they upgrade on
    // their own schedules.
    if (!res.ok) return "stop";
    outbox = (await res.json()) as Outbox;
  } catch {
    return "stop";
  }

  if (!outbox.digests?.length) return "drained";

  // A day already delivered in this round coming back means the acknowledgement
  // did not take — the server still has it owed, and asking again would be
  // handed the same batch for as long as the app stayed open. One repeat is the
  // whole signal, so the round ends here rather than posting it a third time.
  if (outbox.digests.some((d) => already.has(d.day))) return "stop";

  // Newest first, as the server returns them, and stopping at the first
  // transient failure. What stays owed is then always a contiguous run of the
  // oldest days rather than a sequence with holes in it, and a gateway that is
  // down is asked once rather than once per day in the window.
  const settled: string[] = [];
  let stalled = false;
  for (const digest of outbox.digests) {
    const went = await post(outbox.endpoint, digest.payload);
    if (went === "later") {
      stalled = true;
      break;
    }
    settled.push(digest.day);
    already.add(digest.day);
  }

  if (!settled.length) return "stop";

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
    //
    // It does, however, end the round. The server still has those days marked
    // owed, so asking again would be handed the same batch and posting it
    // again would be the only thing this loop ever did.
    return "stop";
  }

  return stalled ? "stop" : "more";
}

/**
 * Empty the outbox, rather than take one bite out of it.
 *
 * ## Why this is a loop
 *
 * It used to be a single batch: ask once, deliver what came back, acknowledge,
 * return. With a bounded batch that is not "collect the telemetry", it is
 * "collect some of the telemetry" — an install with more days owed than fit in
 * one response needed as many rounds as it had batches, and a round only came
 * around on a restart or on the next tick.
 *
 * The visible symptom was a dashboard that stayed stale across a restart while
 * nothing anywhere reported a problem. Days *were* being delivered; they were
 * the oldest ones, which the dashboard already had, so its newest day did not
 * move and the only honest reading from outside was that delivery was broken.
 *
 * Both halves of that are now fixed — the server leads with the newest day and
 * serves the whole window in one response — so this loop will almost always
 * run exactly once. It exists for the case where that is not true, and so that
 * "the outbox is empty when this returns" is a property rather than a hope.
 */
const MAX_BATCHES = 8;

async function carry(s: Connected) {
  const auth = { authorization: `Bearer ${s.token}` };

  // What has gone out in this round, so a lost acknowledgement is noticed
  // rather than re-posted. `collect` stops as soon as the server offers a day
  // that is in here.
  const already = new Set<string>();

  // Bounded as well, not `while (true)`. The repeat check above is the precise
  // guard; this is the backstop for a server that answers with something new
  // every time, which no correct one does.
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    if ((await collect(s, auth, already)) !== "more") return;
  }
}

let ticking: ReturnType<typeof setInterval> | undefined;

/**
 * Start carrying, once, for the lifetime of the window.
 *
 * Also runs when the set of connected servers changes, so a server added in
 * the middle of a session does not wait for the next tick to report for the
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

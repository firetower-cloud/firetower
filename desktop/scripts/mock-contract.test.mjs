/**
 * The mock, read against the contract it stands in for.
 *
 * `mock-server.mjs` is what every client is driven against for demos,
 * screenshots and both e2e suites — so when it drifts from
 * `api/openapi.json`, nothing goes red anywhere. A picker offers nothing, a
 * composer refuses to start, a meter draws no number, and every one of those
 * reads as the app's own bug for as long as it takes somebody to think of
 * doubting the fixture. Three agents tripped over two such faults in one
 * afternoon; a sweep found nineteen more. That is the argument for this file.
 *
 * **It is not a list of expectations.** Every `operationId` in the contract
 * maps onto exactly one generated zod schema by orval's own rule —
 * `list_accounts` is `ListAccountsResponse` — so what is written out below is
 * only *which concrete path to ask for*, and the assertion itself is the
 * generated schema. Change a Rust handler, run `just gen`, and this tightens
 * with it rather than needing to be rewritten. `.github/workflows/desktop.yml`
 * already runs on changes to `api/openapi.json`, so it runs on exactly the
 * change that can break it.
 *
 * **What it cannot see.** A zod object strips what it does not know, so a
 * field the mock invents is not caught here — only a missing required one, a
 * wrong type, or a value outside a closed enum. The contract's enums are also
 * thinner than the server's: `state` on an account and `status` on a limit are
 * both `string` there, though the server writes two values and three. Those
 * are read by hand, against the handler, and the fixture carries the finding
 * as a comment where it was fixed.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schemas from "~/api/generated/index.zod.ts";

const CONTRACT = JSON.parse(
  readFileSync(new URL("../../api/openapi.json", import.meta.url), "utf8"),
);

/**
 * What to put in a path parameter, by name.
 *
 * The mock serves a fixed cast — one session, one host, the skills in its own
 * library — so asking for `{id}` means asking for the id that cast uses.
 */
const CAST = { id: "s_1", kind: "ClaudeCode" };

/** Where the cast above names the wrong thing, by operation. */
const FOR = {
  artifact_address: { id: "a_checkout" },
  get_identity: { id: "github" },
  get_run: { id: "ur_1" },
  list_grants: { id: "d_1" },
  list_items: { id: "d_1" },
  list_members: { id: "t_1" },
  list_provider_repos: { id: "github" },
  list_tracker_scopes: { id: "gh_1" },
  provider_connection: { id: "github" },
  review_skill: { id: "sk_1" },
  skill_detail: { id: "sk_1" },
  update_run: { id: "ur_1" },
};

/** A query string, where a read needs one to answer at all. */
const QUERY = { download_file: "?path=src/quota.rs" };

/**
 * Reads being fixed on another branch, which this must not also claim.
 *
 * `session_skills` answers a bare array of ids where `SessionSkills` is
 * `{ selected, alwaysOn?, repos? }` — found by this sweep, and already fixed
 * on `agent/…-eng-skills-composer` (#472) along with the picker that reads
 * it. **Delete this entry when that lands**; the check costs nothing and the
 * exception is the only thing keeping it quiet.
 */
const ELSEWHERE = new Set(["session_skills"]);

/**
 * The scenes worth sweeping as well as the default one.
 *
 * A scene is how the mock reaches a state its default fixture is not in, and
 * three of the mismatches this file was written for were only reachable from
 * one — `limit-hit` served a spent subscription with no `observedAt` on it
 * and an `Account` where a `Switch` belongs. The slow ones are left out on
 * purpose: `slow-repos` and `probe-slow` sleep for thirty seconds, which is
 * their whole point.
 */
const SCENES = [
  "team", "team-delegated", "team-failed", "ws-many", "ws-done", "ws-few",
  "calm", "longname",
  "codex", "codex-done", "subagent", "subagent-done", "scroll-asking",
  "one-repo", "merged", "locked", "needs-setup", "empty", "bare",
  "no-artifacts", "no-repos", "no-hosts", "fresh-install", "host-needs-app",
  "no-machines", "long-machine", "no-trackers", "no-tasks", "no-people",
  "no-dirs", "no-secrets", "no-roles", "no-retired", "limit-hit",
  "upgrading", "needs-signin", "voice-unset", "host-connected",
];

/** `list_accounts` → `ListAccountsResponse`, which is orval's own rule. */
const pascal = (id) => id.split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join("");

/** Every read in the contract, with its path filled in from the cast. */
const reads = () => {
  const out = [];
  for (const [template, ops] of Object.entries(CONTRACT.paths)) {
    const op = ops.get;
    if (!op?.operationId) continue;
    const named = { ...CAST, ...(FOR[op.operationId] ?? {}) };
    let path = template;
    let missing = null;
    for (const [, name] of template.matchAll(/\{([^}]+)\}/g)) {
      if (named[name] === undefined) missing = name;
      else path = path.replace(`{${name}}`, encodeURIComponent(named[name]));
    }
    out.push({
      id: op.operationId,
      template,
      path: path + (QUERY[op.operationId] ?? ""),
      schema: schemas[`${pascal(op.operationId)}Response`],
      missing,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
};

const EVERY = reads();

/**
 * A port nothing else on this machine is using.
 *
 * A mock takes its port as an argument and prints back whatever it was
 * given, so port 0 — "whichever is free" — would leave this with a literal 0
 * to connect to. The free port is found here and handed over.
 */
const freePort = () =>
  new Promise((settle) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port: found } = probe.address();
      probe.close(() => settle(found));
    });
  });

/** One mock, running, with its port. */
const start = async (file) => {
  const port = await freePort();
  const child = spawn(
    "node",
    [fileURLToPath(new URL(`./${file}`, import.meta.url)), String(port)],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  await new Promise((settle, fail) => {
    const giveUp = setTimeout(() => fail(new Error(`${file} did not come up`)), 15_000);
    child.on("error", fail);
    child.stdout.on("data", () => {
      clearTimeout(giveUp);
      settle();
    });
  });
  return { port, child };
};

/**
 * One read, checked.
 *
 * `null` for a read the mock does not serve: a 404 is the mock saying so
 * out loud, which is a gap rather than a lie, and `assert-connected.mjs` is
 * what hunts those. Anything it *does* answer has to be the shape the client
 * was generated against.
 */
const check = async (port, read) => {
  const answer = await fetch(`http://localhost:${port}${read.path}`);
  if (!(answer.headers.get("content-type") ?? "").includes("json")) {
    return answer.ok ? null : `${read.path} answered ${answer.status}`;
  }
  const body = await answer.json();
  if (answer.status === 404 && body?.code === "NotFound") return null;
  if (answer.status !== 200) {
    return `${read.id} — ${read.path} answered ${answer.status}: ${JSON.stringify(body).slice(0, 160)}`;
  }
  const verdict = read.schema.safeParse(body);
  if (verdict.success) return null;
  const said = verdict.error.issues
    .map((i) => `${i.path.map((p) => (typeof p === "number" ? "[]" : p)).join(".") || "(whole body)"}: ${i.message}`)
    .filter((line, at, all) => all.indexOf(line) === at);
  return `${read.id} — ${read.path}\n    ${said.join("\n    ")}`;
};

it("finds a generated schema for every read in the contract", () => {
  // Guards the `pascal` rule above: a generator that changed its naming would
  // otherwise turn this whole file into a hundred silent passes.
  expect(EVERY.filter((r) => !r.schema).map((r) => r.id)).toEqual([]);
});

let running = null;
const at = () => running.port;

/**
 * **`mock-server.mjs` only, and `mock-retired.mjs` deliberately not.**
 *
 * The sibling is a second fixture for the machine-retirement screens, and it
 * had the same faults — `state: "ready"` was in both, separately — which are
 * fixed alongside these. It is not swept here because it still answers
 * **`[]` with a 200** for every path it does not serve, which is what this
 * one did until the catch-all became a 404: three white screens came out of
 * that, because `[]` is truthy and sails past a `data?.x` guard. Nothing can
 * tell that apart from an answer, so every read it does not serve would be
 * reported as an object-shaped route answering an array. Making its
 * catch-all a 404 is the right fix and is a behaviour change to a harness
 * two screenshot scripts drive, which is its own piece of work.
 */
beforeAll(async () => {
  running = await start("mock-server.mjs");
}, 30_000);
afterAll(() => running?.child.kill());

const put = (named) => fetch(`http://localhost:${at()}/__reset?scene=${named}`);

describe("mock-server.mjs answers each read in the shape the contract gives it", () => {
  for (const read of EVERY) {
    const run = read.missing || ELSEWHERE.has(read.id) ? it.skip : it;
    run(`${read.id} — ${read.template}`, async () => {
      await put("default");
      expect(await check(at(), read)).toBeNull();
    });
  }
});

/**
 * And again in each scene, because a scene is a different fixture.
 *
 * One test per scene rather than per read: a scene's whole answer is one
 * thing to look at, and the message carries every read that disagreed.
 */
describe("and in every scene it can be put into", () => {
  for (const named of SCENES) {
    it(named, async () => {
      await put(named);
      const wrong = [];
      for (const read of EVERY) {
        if (read.missing || ELSEWHERE.has(read.id)) continue;
        const said = await check(at(), read);
        if (said) wrong.push(said);
      }
      expect(wrong, `playing ${named}`).toEqual([]);
    });
  }
});

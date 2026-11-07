/**
 * What a rewrite stopped calling.
 *
 * **The first functional regression this redesign produced** was the rail's
 * context menu: right-click a workspace to rename or end it. `Rail.tsx`
 * became `RailPanel.tsx` and the whole interaction went with it. Nothing
 * caught it — not the sweep, which checks a state renders; not the
 * connectedness check, which checks a control goes somewhere; not Coverage,
 * which tracks what is *drawn*. A drawing has no representation of the
 * previous build, so **the check has to compare two builds, and only the
 * code has two**.
 *
 * So: for each component the delta table marks `replaced`, diff the API the
 * old file reached for against the new one. A hook used before and used
 * nowhere now is either a deliberate removal or a dropped feature, and the
 * difference has to be *stated* rather than discovered three weeks later.
 *
 *   node scripts/check-hook-delta.mjs [base]
 *
 * `KNOWN` is the ratchet: a removal that is meant carries a reason here, and
 * anything else fails. `renameSession` and `useEndWorkspace` would both have
 * failed this the day the rail was rewritten.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/* Paths in the delta table are repo-relative; this runs from `desktop/`. */
const ROOT = resolve(execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim());

const BASE = process.argv[2] ?? "origin/main";

/** The delta table's `replaced` rows: what became what. */
const REPLACED = [
  { was: "desktop/src/ui/Rail.tsx", now: ["desktop/src/ui/Rail.tsx", "desktop/src/ui/RailPanel.tsx"] },
  { was: "desktop/src/ui/Dashboard.tsx", now: ["desktop/src/ui/Home.tsx"] },
];

/** Removals that are meant, with the reason. Anything not here is a finding. */
const KNOWN = {
  "desktop/src/ui/Rail.tsx": {
    useHostOf: "the old rail drew the machine on every row; the workspace's Overview says where it runs, and a 252px row that carries a repository, a branch, a machine and a state is a paragraph",
    whereItRuns: "as above — it moved to the Overview rather than being dropped",
  },
  "desktop/src/ui/Dashboard.tsx": {
    useStart: "`StartComposer` owns starting now, and calls it itself",
    useQueryClient: "nothing on the home mutates, so there is no cache to invalidate",
    useHostOf: "the home says what is waiting, not where it runs",
    /* **Reported, not resolved.** This one is a capability and not a
       rendering: the Dashboard could end every workspace at once, or every
       one matching the filter, with a confirmation that said how many could
       not be reached. The home has no equivalent and the rail's menu ends
       one at a time. Whether that should come back is a design decision, so
       it is written down here rather than quietly marked done. */
    endAllSessions: "REPORTED — a bulk end the home has no equivalent for; with the designer",
    useConfirm: "went with `endAllSessions`; see above",
  },
};

/** The old side comes out of git; the new side comes off disk, so this fails
    while you can still do something about it rather than after the commit. */
const at = (rev, path) => {
  if (rev === null) {
    const full = resolve(ROOT, path);
    return existsSync(full) ? readFileSync(full, "utf8") : "";
  }
  try {
    return execFileSync("git", ["show", `${rev}:${path}`], { encoding: "utf8" });
  } catch {
    return "";
  }
};

/**
 * What a file reaches for — **the API, not React**.
 *
 * `useState`, `useMemo` and the rest say nothing about a feature; a rewrite
 * that stops calling `useState` has stopped having state, which is not a
 * dropped capability. What matters is what it asked the server for and what
 * it did to a workspace.
 */
const REACT = new Set([
  "useState", "useMemo", "useEffect", "useRef", "useCallback", "useContext",
  "useReducer", "useLayoutEffect", "useId", "useSyncExternalStore", "useNow",
]);
const reaches = (text) =>
  new Set(
    [...text.matchAll(/\b(use[A-Z]\w+|[a-z]\w*(?:Session|Sessions|Workspace|Run|Skill|Artifact|Host|Role)s?)\s*\(/g)]
      .map((m) => m[1])
      .filter((h) => !REACT.has(h)),
  );

let findings = 0;
for (const { was, now } of REPLACED) {
  const before = reaches(at(`${BASE}`, was) || at("HEAD~1", was));
  const after = new Set(now.flatMap((f) => [...reaches(at(null, f))]));
  const dropped = [...before].filter((h) => !after.has(h)).sort();
  const known = KNOWN[was] ?? {};
  const unexplained = dropped.filter((h) => !(h in known));

  console.log(`\n  ${was} → ${now.map((n) => n.split("/").pop()).join(", ")}`);
  for (const h of dropped) {
    const why = known[h];
    console.log(`    ${why ? "·" : "✗"} ${h}${why ? ` — ${why}` : "  (dropped, and nothing says why)"}`);
  }
  if (dropped.length === 0) console.log("    · nothing dropped");
  findings += unexplained.length;
}

if (findings) {
  console.log(`\n  ${findings} call(s) a rewrite stopped making, with no reason recorded.`);
  console.log("  Either restore it, or add it to KNOWN with the reason.");
  process.exit(1);
}
console.log("\n  Every call a rewrite dropped is accounted for.");

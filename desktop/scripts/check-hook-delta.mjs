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
import { join, resolve } from "node:path";

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

/**
 * **Components deleted outright**, which `REPLACED` cannot express: there is
 * no "now" to diff against, so a whole file's worth of calls disappears and
 * this said nothing at all. `QuickOpen` went and was not reported anywhere —
 * the check had no bucket for it, which is worse than an unaccounted finding,
 * because an unaccounted finding is at least visible.
 *
 * Each one names what it did and why it is gone. The file must actually be
 * absent: a row here for a file still on disk is a stale record, and a stale
 * record in the thing that catches stale records is the whole problem again.
 */
const REMOVED = {
  /* **Three of these were already gone and nothing said so.** They were
     removed in `26bcb5f8` and `2dd4ab23`, explained at length in those commit
     messages, and recorded in no check — which is exactly the gap the bucket
     was added to close, found by adding it. */
  "desktop/src/ui/ServerStrip.tsx":
    "The 48px server strip, and with it the `all` scope and the `firetower.scope` key. One Firetower at a time now, behind the 62px rail; the old key is read once and carried over so nobody is moved. `26bcb5f8`.",
  "desktop/src/ui/Fleet.tsx":
    "Every server's work on one screen — the unified inbox, which went with the `all` scope. **A real feature, removed deliberately.** What spans Firetowers is untouched: the dock badge and `islandState(fleet)` still do. Inside the window it is narrower — one ember dot on the rail's avatar meaning *waiting somewhere you are not* — and this file's headline and grouping survive as the switch menu's. `26bcb5f8`.",
  "desktop/src/ui/StatusBar.tsx":
    "The strip of chrome along a workspace's bottom edge. Its three facts were not the same kind of fact: the branch and the age are sentences at the top of the Overview now, and `whereItRuns` and `HostCard` moved to `components/WhereItRuns.tsx` where the machine vocabulary already was. `2dd4ab23`.",
  "desktop/src/ui/QuickOpen.tsx":
    "⌘P, a finder scoped to this workspace's files. Deprecated, and the user asked for it to go. ⌘P is left deliberately unbound rather than reassigned — reassigning a key somebody has muscle memory for is worse than leaving it quiet. **REPORTED: the palette does not search files.** `Palette.tsx` offers workspaces and the rail's destinations and nothing else, so with this gone there is no way to reach a file by typing its name; the file tree is the only route. `components.html`'s own Palette specimen draws a file row, so the drawing disagrees with the build on this, and the drawing's keyboard table still lists ⌘P as bound. Both are with the designer.",
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

/* Deletions, and whether each record is still true. */
for (const [path, why] of Object.entries(REMOVED)) {
  const gone = !existsSync(join(ROOT, path));
  const had = [...reaches(at(`${BASE}`, path) || at("HEAD~1", path) || "")];
  console.log(`\n  ${path} — removed`);
  console.log(`    ${gone ? "·" : "✗"} ${gone ? why : "still on disk — this record is stale, and a stale record here is the defect this check exists for"}`);
  if (had.length) console.log(`      it called: ${had.sort().join(", ")}`);
  if (!gone) findings++;
}

/* A component deleted without a record. Scoped to the files this branch
   actually deleted, so it cannot drift into auditing the whole repository. */
const deleted = execFileSync("git", ["diff", "--diff-filter=D", "--name-only", `${BASE}...HEAD`], { encoding: "utf8", cwd: ROOT })
  .split("\n")
  .filter((f) => /^desktop\/src\/.+\.tsx$/.test(f) && !(f in REMOVED));
if (deleted.length) {
  console.log("");
  for (const f of deleted) console.log(`  ✗ ${f} was deleted and nothing says why`);
  findings += deleted.length;
}

if (findings) {
  console.log(`\n  ${findings} thing(s) a rewrite stopped doing, with no reason recorded.`);
  console.log("  Either restore it, or record it in KNOWN or REMOVED with the reason.");
  process.exit(1);
}
console.log("\n  Every call a rewrite dropped, and every component it deleted, is accounted for.");

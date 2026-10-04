/**
 * Reading a dropped folder into something the server will take.
 *
 * **A folder arrives as entries, not as files.** `webkitGetAsEntry` is the only
 * thing that can tell a directory from a zero-byte file, and it is readable
 * only while the drop event is being handled — so the walk starts synchronously
 * off the event and the promises it returns are awaited afterwards. This is the
 * same constraint `ui/drop.ts` documents for attachments; what is new here is
 * that a folder is no longer refused.
 *
 * **What a drop can be.** One skill folder, a folder of skill folders — which
 * is what `~/.claude/skills` actually is, and the common case — or a `.zip` of
 * either. All three end as the same list of bundles, so the review screen does
 * not care which happened.
 *
 * **Nothing here decides anything.** Names, descriptions and limits are checked
 * again on the server, which is what enforces them; this is only so the message
 * arrives before the upload rather than after it.
 */
import { unzip } from "fflate";

/** A file on its way to the server. `contents` is base64, because a bundle may
 *  hold a font. */
export type Incoming = { path: string; contents: string; executable: boolean };

/** One skill found in a drop, and whatever is wrong with it. */
export type Found = {
  /** Where it came from, for the row that says so. */
  from: string;
  name: string;
  description: string;
  frontmatter: Record<string, unknown>;
  body: string;
  files: Incoming[];
  bytes: number;
  /** Refusals. A bundle with any of these cannot be imported. */
  errors: string[];
  /** Worth saying, and never a refusal. */
  warnings: string[];
  /** What it will do to a session, read from the bundle. */
  risk: string[];
};

/** Frontmatter fields only Claude Code reads. Preserved, and worth saying. */
const ONLY_CLAUDE = [
  "when_to_use", "argument-hint", "arguments", "disable-model-invocation", "user-invocable",
  "disallowed-tools", "model", "effort", "context", "agent", "background", "hooks", "paths", "shell",
];

/** Junk that is in a folder because of the tools, not because of the skill. */
const SKIP = /(^|\/)(\.git|node_modules|\.DS_Store|__pycache__|\.venv|\.idea|\.vscode)(\/|$)/;

/** Names an agent already answers to, which a skill of the same name shadows. */
const RESERVED = new Set([
  "code-review", "review", "doctor", "debug", "batch", "run", "verify", "loop", "init",
  "security-review", "simplify", "compact", "clear", "config", "model", "help", "imagegen",
  "plan", "skill-creator", "skill-installer", "plugin-creator", "review-agent",
]);

const MOST_FILES = 100;
const BIGGEST_FILE = 2 * 1024 * 1024;
const BIGGEST_VERSION = 25 * 1024 * 1024;

/* ── reading a drop ──────────────────────────────────────────────────── */

type Raw = { path: string; bytes: Uint8Array };

/**
 * Everything a drop contained, as a flat list of paths and bytes.
 *
 * The entries have to be taken off the event synchronously; what they yield is
 * awaited after. A `DataTransferItemList` is indexed and not iterable, so
 * spreading it throws — the same trap `drop.ts` hit.
 */
export function readDrop(dt: DataTransfer | null): Promise<Raw[]> {
  const list = dt?.items;
  if (!list) return Promise.resolve([]);
  const jobs: Promise<Raw[]>[] = [];
  for (let i = 0; i < list.length; i++) {
    const entry = list[i]?.webkitGetAsEntry?.();
    if (entry) jobs.push(walk(entry, ""));
    else {
      const file = list[i]?.getAsFile?.();
      if (file) jobs.push(readOne(file, file.name));
    }
  }
  return Promise.all(jobs).then((all) => all.flat());
}

/** The same, for a file input, which gives `webkitRelativePath` instead. */
export async function readFiles(files: FileList | null): Promise<Raw[]> {
  const out: Raw[] = [];
  for (const file of Array.from(files ?? [])) {
    const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    out.push(...(await readOne(file, path)));
  }
  return out;
}

async function readOne(file: File, path: string): Promise<Raw[]> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (path.toLowerCase().endsWith(".zip")) return openZip(bytes, path.replace(/\.zip$/i, ""));
  return [{ path, bytes }];
}

function walk(entry: FileSystemEntry, prefix: string): Promise<Raw[]> {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (SKIP.test(path)) return Promise.resolve([]);

  if (entry.isFile) {
    return new Promise((resolve) => {
      (entry as FileSystemFileEntry).file(
        (f) => resolve(readOne(f, path)),
        () => resolve([]),
      );
    }).then((r) => r as Raw[]);
  }

  const reader = (entry as FileSystemDirectoryEntry).createReader();
  /* `readEntries` returns at most a hundred at a time and signals the end with
     an empty batch. Reading once gives a silently truncated folder, which is
     the kind of bug that only shows up on somebody else's large library. */
  const all: FileSystemEntry[] = [];
  const more = (): Promise<FileSystemEntry[]> =>
    new Promise((resolve) => reader.readEntries((batch) => resolve(batch), () => resolve([])));
  const drain = async (): Promise<FileSystemEntry[]> => {
    for (;;) {
      const batch = await more();
      if (batch.length === 0) return all;
      all.push(...batch);
    }
  };
  return drain().then(async (entries) => {
    const out: Raw[] = [];
    for (const child of entries) out.push(...(await walk(child, path)));
    return out;
  });
}

function openZip(bytes: Uint8Array, name: string): Promise<Raw[]> {
  return new Promise((resolve) => {
    unzip(bytes, (err, files) => {
      if (err) return resolve([]);
      const out: Raw[] = [];
      for (const [path, data] of Object.entries(files)) {
        if (path.endsWith("/") || SKIP.test(path) || data.length === 0) continue;
        out.push({ path: `${name}/${path}`, bytes: data });
      }
      resolve(out);
    });
  });
}

/* ── turning that into skills ────────────────────────────────────────── */

/**
 * Group a flat list of paths into the skills it holds.
 *
 * A skill is a directory with a `SKILL.md` directly inside it, so the grouping
 * is by the parent of every `SKILL.md` found. That covers one folder, a folder
 * of folders and a zip of either without any of them being a special case.
 *
 * A drop with no `SKILL.md` anywhere is still reported — as one bundle that
 * cannot be imported, which is a better answer than an empty screen.
 */
export function skillsIn(raw: Raw[]): Found[] {
  const roots = raw
    .filter((f) => f.path.endsWith("/SKILL.md") || f.path === "SKILL.md")
    .map((f) => f.path.slice(0, Math.max(0, f.path.length - "SKILL.md".length - 1)));

  if (roots.length === 0) {
    const top = raw[0]?.path.split("/")[0] ?? "what you dropped";
    return [
      {
        from: top,
        name: top.replace(/[^a-z0-9-]+/gi, "-").toLowerCase().replace(/^-|-$/g, "") || "untitled",
        description: "",
        frontmatter: {},
        body: "",
        files: [],
        bytes: raw.reduce((n, f) => n + f.bytes.length, 0),
        errors: ["No SKILL.md. A skill folder holds one, spelled exactly that way."],
        warnings: [],
        risk: [],
      },
    ];
  }

  return roots.map((root) => bundle(root, raw.filter((f) => inside(f.path, root))));
}

const inside = (path: string, root: string) => (root === "" ? !path.includes("/") || true : path.startsWith(`${root}/`));

function bundle(root: string, raw: Raw[]): Found {
  const folder = root.split("/").filter(Boolean).pop() ?? "skill";
  const files: Incoming[] = raw.map((f) => ({
    path: root === "" ? f.path : f.path.slice(root.length + 1),
    contents: toBase64(f.bytes),
    /* A dropped folder carries no POSIX mode — Tauri hands us HTML5 entries
       rather than OS paths — so it is inferred from a shebang. Nothing is shown
       for it: the standard has no field for it, and in `anthropics/skills` 404
       files are not executable to 26 that are, because every SKILL.md invokes
       through an interpreter. */
    executable: looksExecutable(f.bytes),
  }));

  const skillMd = raw.find((f) => f.path.endsWith("SKILL.md"));
  const text = skillMd ? new TextDecoder().decode(skillMd.bytes) : "";
  const { frontmatter, body, framed } = split(text);

  /* The *file's* name, not a guess at one. Claude Code falls back to the
     folder when this is missing; the standard says required, and so does
     Anthropic's own guide. Inventing one here is how a misspelled key —
     `nae: webapp-testing` — sails through and lands in a shared library under
     a name nothing in the file ever said. */
  const declared = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
  const name = declared || folder;
  const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
  const bytes = raw.reduce((n, f) => n + f.bytes.length, 0);

  const errors: string[] = [];
  const warnings: string[] = [];

  if (!framed)
    errors.push("No frontmatter. A SKILL.md opens with a --- line, the fields, and another ---.");
  else if (!declared) {
    const typo = Object.keys(frontmatter).find((k) => nearly(k) === "name");
    errors.push(
      typo
        ? `No \`name\` field. There is a \`${typo}:\` — did you mean \`name:\`?`
        : "No `name` field. The standard requires one, and it has to match the folder.",
    );
  }

  for (const key of Object.keys(frontmatter)) {
    if (KNOWN.has(key)) continue;
    const meant = nearly(key);
    warnings.push(
      meant
        ? `\`${key}\` is not a field anything reads. Did you mean \`${meant}\`?`
        : `\`${key}\` is not a field anything reads. It is kept in the file and ignored.`,
    );
  }

  if (declared && (!/^[a-z0-9-]{1,64}$/.test(name) || name.startsWith("-") || name.endsWith("-")))
    errors.push("A name is 1 to 64 lowercase letters, digits and hyphens, and does not start or end with one.");
  if (name.includes("claude") || name.includes("anthropic"))
    errors.push("`claude` and `anthropic` are reserved in a skill name.");
  if (!description.trim())
    errors.push("A description is what the model decides on, so it cannot be empty.");
  if (description.length > 1024) errors.push("A description is at most 1024 characters.");
  if (JSON.stringify(frontmatter).match(/[<>]/))
    errors.push("`<` and `>` are not allowed in frontmatter — it is read as part of the system prompt.");
  if (files.length > MOST_FILES) errors.push(`A skill holds at most ${MOST_FILES} files.`);
  if (bytes > BIGGEST_VERSION) errors.push(`A skill is at most ${BIGGEST_VERSION / 1024 / 1024} MB.`);
  for (const f of raw)
    if (f.bytes.length > BIGGEST_FILE)
      errors.push(`${f.path} is larger than the ${BIGGEST_FILE / 1024 / 1024} MB a file may be.`);

  if (declared && declared !== folder)
    warnings.push(`The folder is ${folder} and the name is ${declared}. The standard wants them to match.`);
  if (RESERVED.has(name))
    warnings.push(`An agent already ships a skill called ${name}, and yours would be shadowed by it.`);
  if (raw.some((f) => f.path.endsWith("README.md")))
    warnings.push("A README.md inside a skill folder is not read by anything. It can stay, or go.");
  if (body.split("\n").length > 500)
    warnings.push("The instructions are over 500 lines. Anything long is better in references/, which costs nothing until it is opened.");
  for (const key of Object.keys(frontmatter))
    if (ONLY_CLAUDE.includes(key))
      warnings.push(`\`${key}\` is read by Claude Code and ignored by the others. It is kept either way.`);

  return {
    from: root || folder,
    name,
    description,
    frontmatter,
    body,
    files,
    bytes,
    errors,
    warnings,
    risk: riskOf(frontmatter, body, files.map((f) => f.path)),
  };
}

/** What this bundle will do to a session, read from the bundle itself. */
export function riskOf(frontmatter: Record<string, unknown>, body: string, paths: string[]): string[] {
  const out: string[] = [];
  if (body.includes("!`")) out.push("shell");
  if ("allowed-tools" in frontmatter) out.push("tools");
  if ("hooks" in frontmatter) out.push("hooks");
  if (paths.some((p) => p.startsWith("scripts/"))) out.push("scripts");
  return out;
}

export const RISK_SAYS: Record<string, string> = {
  shell: "Runs shell commands before the model sees it",
  tools: "Pre-approves tools for the turn",
  hooks: "Registers hooks for the whole session",
  scripts: "Ships executable scripts",
};

/* ── the small parsers ───────────────────────────────────────────────── */

/**
 * Frontmatter and body, out of a SKILL.md.
 *
 * Deliberately not a YAML library. The standard allows a scalar, a list and a
 * one-level map at the top level, and that is all this reads — a full parser
 * would be one that disagrees with the server's about an edge case nobody
 * asked for. What it cannot read is kept verbatim in the file, which is what
 * the agent actually loads.
 *
 * `present` is what the file *said*, which is a different question from what
 * the skill is called. A file whose key is misspelled has no `name`, and that
 * has to be a refusal rather than a fallback to the folder — see `bundle`.
 */
export function split(text: string): {
  frontmatter: Record<string, unknown>;
  body: string;
  /** Whether a `---` block was there at all. */
  framed: boolean;
} {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { frontmatter: {}, body: text.trim(), framed: false };

  const out: Record<string, unknown> = {};
  let key: string | null = null;
  let map: Record<string, string> | null = null;
  let list: string[] | null = null;

  for (const line of m[1]!.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;

    // `  - item`, which is how the standard spells a list.
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && key) {
      if (!list) {
        list = [];
        out[key] = list;
      }
      list.push(unquote(item[1]!));
      continue;
    }
    // `  key: value` under a key with nothing after its colon.
    const nested = /^\s{2,}([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (nested && map) {
      map[nested[1]!] = unquote(nested[2]!);
      continue;
    }

    const top = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!top) continue;
    key = top[1]!;
    map = null;
    list = null;
    const value = top[2]!.trim();
    if (value === "") {
      // A list or a map — decided by the first indented line after it.
      map = {};
      out[key] = map;
    } else if (value.startsWith("[") && value.endsWith("]")) {
      out[key] = value
        .slice(1, -1)
        .split(",")
        .map((v) => unquote(v))
        .filter(Boolean);
    } else {
      out[key] = unquote(value);
    }
  }
  return { frontmatter: out, body: text.slice(m[0].length).trim(), framed: true };
}

/** Every field anything reads. Anything else is a typo or a private note. */
const SPEC = ["name", "description", "license", "compatibility", "metadata", "allowed-tools"];
const KIMI = ["type"];
const KNOWN = new Set([...SPEC, ...KIMI, ...ONLY_CLAUDE]);

/** `nae` → `name`. One edit away from a field that exists is a typo. */
function nearly(key: string): string | undefined {
  for (const known of KNOWN) if (editsBetween(key, known) === 1) return known;
  return undefined;
}

/** Levenshtein, stopped at two — nothing here needs the real distance. */
function editsBetween(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 1) return 2;
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(
        row[j]! + 1,
        next[j - 1]! + 1,
        row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    row = next;
  }
  return Math.min(2, row[b.length]!);
}

const unquote = (v: string) => v.trim().replace(/^["'](.*)["']$/s, "$1");

/** A shebang, which is the only evidence a dropped folder carries. */
function looksExecutable(bytes: Uint8Array): boolean {
  return bytes.length > 2 && bytes[0] === 0x23 && bytes[1] === 0x21;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk)
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

/** `12.4 KB`, for a row that has to say how big something is. */
export function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

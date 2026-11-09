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
 *  hold a font. `hash` is sha256 of the bytes — the same fingerprint the
 *  server stores, so the two can be compared without sending anything. */
export type Incoming = { path: string; contents: string; executable: boolean; hash: string };

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
  /** What the library already has under this name. Filled in after the drop
   *  has been read, by asking the server. */
  match?: SkillMatch;
  /** For a same-name skill shared with you that you may edit: add this as its
   *  next version (the default) rather than keeping a copy of your own. */
  asVersion?: boolean;
};

/** What the server found under the same name, if anything. */
export type SkillMatch = {
  id: string;
  path: string;
  version: number;
  identical: boolean;
  identicalToVersion?: number | null;
  mayWrite: boolean;
  mine: boolean;
  unchanged: number;
  changed: number;
  added: number;
  removed: number;
};

/** Frontmatter fields only Claude Code reads. Preserved, and worth saying. */
const ONLY_CLAUDE = [
  "when_to_use", "argument-hint", "arguments", "disable-model-invocation", "user-invocable",
  "disallowed-tools", "model", "effort", "context", "agent", "background", "hooks", "paths", "shell",
];

/**
 * Tags that are the harness talking, not the skill.
 *
 * The frontmatter rule below is blunt because it can afford to be — a name
 * and a description lose nothing by having no angle brackets in them. A body
 * cannot: 15 of the 26 skills Anthropic and OpenAI ship have `<` or `>` in
 * theirs, because `docx` has to quote `<w:r>`, `algorithmic-art` has to quote
 * `<html>` and `skill-creator` has to write `<skill-name>`. Refusing those
 * would refuse most of the real corpus to stop nothing.
 *
 * So the body is checked for the narrow thing instead: text shaped like the
 * framing an agent uses to tell its own instructions from everything else.
 * A skill is loaded into context on invocation, and a shared one is written by
 * somebody other than whoever runs it, so a `<system-reminder>` in a body is
 * an instruction with a forged return address. None of the 26 contain one.
 */
const HARNESS_TAGS = [
  "system-reminder",
  "function_calls",
  "function_results",
  "task-notification",
  "command-name",
  "command-message",
  "user-prompt-submit-hook",
  /* A forged tool call, which is the worst of these: it does not ask the model
     to do something, it claims the harness already did. */
  "invoke",
];
/* `antml:` is a whole namespace, so it matches on the prefix. A name has to
   end where a tag's name ends — so `<invokes-the-api>` is prose and
   `<invoke\n name=…>` is not. */
const FORGED = new RegExp(
  `</?\\s*(?:antml:[a-z_-]*|(?:${HARNESS_TAGS.join("|")})(?=[\\s>/]|$))`,
  "i",
);

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
/** Mirrors `BIGGEST_DESCRIPTION` on the server, which is what enforces it. */
const BIGGEST_DESCRIPTION = 2048;

/** Some bytes as text, or `undefined` if they are a font or an image. */
function asText(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes as unknown as ArrayBufferView);
  } catch {
    return undefined;
  }
}

/**
 * `text` with everything a reader sees as code taken out.
 *
 * A line whose backticks do not pair up is kept whole rather than treated as
 * an open span: an unmatched backtick renders as a literal one, so reading it
 * as code would be a way to hide a tag behind a single stray character.
 */
function outsideCode(text: string): string {
  const out: string[] = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    const opens = line.trimStart();
    if (opens.startsWith("```") || opens.startsWith("~~~")) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const ticks = line.split("`").length - 1;
    // Alternating: outside a span, inside, outside, …
    out.push(ticks % 2 === 0 ? line.split("`").filter((_, i) => i % 2 === 0).join(" ") : line);
  }
  return out.join("\n");
}

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

/** sha256 of some bytes, hex — the same thing the server stores per file. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
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
export async function skillsIn(raw: Raw[]): Promise<Found[]> {
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

  return Promise.all(
    roots.map((root) => bundle(root, raw.filter((f) => inside(f.path, root)))),
  );
}

const inside = (path: string, root: string) => (root === "" ? !path.includes("/") || true : path.startsWith(`${root}/`));

async function bundle(root: string, raw: Raw[]): Promise<Found> {
  const folder = root.split("/").filter(Boolean).pop() ?? "skill";
  const files: Incoming[] = await Promise.all(raw.map(async (f) => ({
    path: root === "" ? f.path : f.path.slice(root.length + 1),
    contents: toBase64(f.bytes),
    hash: await sha256Hex(f.bytes),
    /* A dropped folder carries no POSIX mode — Tauri hands us HTML5 entries
       rather than OS paths — so it is inferred from a shebang. Nothing is shown
       for it: the standard has no field for it, and in `anthropics/skills` 404
       files are not executable to 26 that are, because every SKILL.md invokes
       through an interpreter. */
    executable: looksExecutable(f.bytes),
  })));

  const skillMd = raw.find((f) => f.path.endsWith("SKILL.md"));
  const text = skillMd ? new TextDecoder().decode(skillMd.bytes) : "";
  const { frontmatter, body, framed, unread, undecoded } = split(text);

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
  /* A line nothing here can read is a field the agent gets and no check saw —
     including `riskOf` below, which is the badge somebody reads before they
     approve this. Refused rather than skipped, as on the server. */
  else if (unread.length)
    errors.push(
      `The frontmatter has a line nothing reads: \`${brief(unread[0]!)}\`. ` +
        "A line is blank, a comment, `key: value` at the left margin, a `- list item`, " +
        "an indented `key: value` under one, or part of a block scalar. A full YAML reader " +
        "takes more than that — `description : x` with a space before the colon, or a quoted " +
        "key — so a line this one cannot read is a field nothing on this screen has checked.",
    );
  /* And the same of a value, answered the same way: the decoder is what
     reports. A scalar kept as the characters that spell it is a scalar whose
     meaning no rule here saw — the `<`/`>` check below is asked about
     `\u003c` while a real YAML reader hands the agent a `<`. */
  else if (undecoded.length)
    errors.push(
      `The frontmatter has a value nothing here fully reads: \`${brief(undecoded[0]!)}\`. ` +
        "Reading a value means decoding it, and a quoted scalar is decoded here while a plain " +
        "or a block scalar means exactly what it spells. Anything else — a flow mapping, a " +
        "tag, an anchor, an alias, a quote that does not close where it looks like it does — " +
        "a real YAML reader decodes and this one keeps verbatim. " +
        "Write it as an indented `key: value` map, a `- list`, or a plain or quoted scalar.",
    );
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
  if (description.length > BIGGEST_DESCRIPTION)
    errors.push(`A description is at most ${BIGGEST_DESCRIPTION} characters.`);
  if (JSON.stringify(frontmatter).match(/[<>]/))
    errors.push("`<` and `>` are not allowed in frontmatter — it is read as part of the system prompt.");
  /* Every text file, not only SKILL.md: a `references/` file is opened into
     the same context on the same turn. A tag inside a code span is one being
     described rather than spoken, which is worth saying and not a refusal —
     `claude-api` names `<system-reminder>` in three of its reference files,
     one of them to explain that the pattern is forgeable. */
  for (const f of raw) {
    const text = asText(f.bytes);
    if (text === undefined) continue;
    const spoken = FORGED.exec(outsideCode(text));
    if (spoken)
      errors.push(
        `${f.path} contains \`${spoken[0]}\`, which is how an agent frames its own messages. ` +
          "A skill cannot speak as the harness. Write the name without the angle brackets, " +
          "or put it in a code span if the point is to describe it.",
      );
    else if (FORGED.test(text))
      warnings.push(`${f.path} mentions an agent's own framing in a code span. Read as code, not as an instruction.`);
  }
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

/**
 * As much of a line as belongs in a message about it.
 *
 * The same reasoning as the server's `briefly`: a line being quoted back is
 * attacker-controlled, and this message is read by a person. Angle brackets
 * and backticks go, because the quote sits inside a code span and the one
 * thing a frontmatter refusal must not do is carry a forged frame out with it.
 */
function brief(line: string): string {
  const safe = [...line.slice(0, 24)]
    .map((c) => (c === " " || (c > " " && c < "\u007f" && c !== "<" && c !== ">" && c !== "`") ? c : "."))
    .join("");
  return line.length > 24 ? `${safe}…` : safe;
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
 * Deliberately not a YAML library. The standard allows a scalar, a list, a
 * one-level map and a block scalar at the top level, and that is all this
 * reads — a full parser would be one that disagrees with the server's about an
 * edge case nobody asked for. What it cannot read is kept verbatim in the
 * file, which is what the agent actually loads.
 *
 * **Block scalars are not an edge case.** `description: >` is how a
 * description long enough to be useful is actually written, and Anthropic's
 * own skills write it that way. Read as a plain scalar it comes out as the
 * one-character string `">"` — which loses the description silently and then
 * trips the `<`/`>` rule below, reporting an injection risk for a character
 * the author never wrote as content.
 *
 * `present` is what the file *said*, which is a different question from what
 * the skill is called. A file whose key is misspelled has no `name`, and that
 * has to be a refusal rather than a fallback to the folder — see `bundle`.
 *
 * **And `unread` is what it could not read**, which is the half that makes
 * the rest of this honest. The regex above wants `[A-Za-z0-9_-]` before the
 * colon, so `allowed-tools : Bash(curl:*)` — one space — used to be dropped
 * silently: invisible to this parser, read perfectly well by Claude Code, and
 * so **absent from `riskOf`**. The review screen then showed a badge saying
 * "no tools, no hooks" about a bundle carrying both, which is worse than
 * showing nothing. A line this reader cannot read is reported, and `bundle`
 * makes it an error — the same answer the server gives.
 */
export function split(text: string): {
  frontmatter: Record<string, unknown>;
  body: string;
  /** Whether a `---` block was there at all. */
  framed: boolean;
  /** Lines inside the frame this reader dropped. */
  unread: string[];
  /** Lines whose value this reader kept as text rather than decoding. */
  undecoded: string[];
} {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { frontmatter: {}, body: text.trim(), framed: false, unread: [], undecoded: [] };

  const out: Record<string, unknown> = {};
  const unread: string[] = [];
  const undecoded: string[] = [];
  const lines = m[1]!.split(/\r?\n/);
  let key: string | null = null;
  let map: Record<string, unknown> | null = null;
  let list: unknown[] | null = null;
  /* **The one place a value's verdict is recorded.** The value only comes out
     of `readValue` through here, so a position that reads a value cannot
     forget to say whether reading is what happened — the same reason the
     dropped line is counted in exactly one place below. */
  const took = (line: string, got: Scalar) => {
    if (!got.read) undecoded.push(line);
    return got.value;
  };

  /* The indentation the lines under the current key sit at, set by the first
     of them. **One level of nesting is all this reader models**, and this is
     what makes that a statement it can keep. It folded every nested pair into
     one flat map whatever its depth, so a key three levels deep landed beside
     its own parent's siblings and a later sibling of the same name overwrote
     it — after it had been decoded. `metadata:` / `  a:` / `    b: "\u003c…"`
     / `  b: plain` left a frontmatter with no `<` in it for the check below
     while a real reader keeps it at `metadata.a.b`. Mirrors the server. */
  let nest: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const lead = line.length - line.trimStart().length;
    const astray = lead > 0 && nest !== null && lead !== nest;

    // `  - item`, which is how the standard spells a list.
    const item = astray ? null : /^\s+-\s+(.*)$/.exec(line);
    if (item && key) {
      if (!list) {
        list = [];
        out[key] = list;
      }
      nest = lead;
      list.push(took(line, readValue(item[1]!, "item")));
      continue;
    }
    // `  key: value` under a key with nothing after its colon. The
    // `(?=[ \t]|$)` is the mirror of `key_colon`'s: **a `:` is a mapping
    // indicator only when a space, a tab or the end of the line follows
    // it.** Without it these two regexes split on the first colon, so
    // `  a:b: "\u003c…"` read as key `a` holding the text `b: "\u003c…"`
    // — the eighth value shape, where libyaml reads one key `a:b` and
    // decodes the escape in its value. A badge drawn from a reading nobody
    // had, again.
    const nested = astray ? null : /^\s{2,}([A-Za-z0-9_-]+):(?=[ \t]|$)\s*(.*)$/.exec(line);
    if (nested && map) {
      nest = lead;
      map[nested[1]!] = took(line, readValue(nested[2]!, "value"));
      continue;
    }

    const top = /^([A-Za-z0-9_-]+):(?=[ \t]|$)\s*(.*)$/.exec(line);
    // The one place a line can be dropped, and it is counted here.
    if (!top) {
      unread.push(line);
      continue;
    }
    key = top[1]!;
    map = null;
    list = null;
    nest = null;
    const value = top[2]!.trim();

    // `>`, `|`, and either with a chomp (`-`/`+`) or an explicit indent
    // digit. Nothing that is content looks like this, so matching it cannot
    // take a description away from somebody who meant to write one.
    const block = /^([|>])((?:[1-9]|[+-])*)$/.exec(value);
    if (block) {
      const style = block[1]! as "|" | ">";
      const marks = block[2]!;
      const chomp = marks.includes("-") ? "strip" : marks.includes("+") ? "keep" : "clip";
      // An indent indicator says how far in the block is; without one, the
      // first non-empty line decides.
      let indent = Number(/[1-9]/.exec(marks)?.[0] ?? 0);
      const took: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const l = lines[j]!;
        if (!l.trim()) {
          took.push("");
          continue;
        }
        const lead = l.length - l.trimStart().length;
        if (!indent) {
          if (lead === 0) break;
          indent = lead;
        }
        if (lead < indent) break;
        took.push(l.slice(indent));
      }
      // Whether a line ended the block or the frontmatter simply ran out.
      // That is the difference between there being a line break after the
      // last line and there not being one, which is what chomping acts on.
      const ended = j < lines.length;
      // `- 1`, because the loop's own `i++` steps onto the line that ended it.
      i = j - 1;
      out[key] = fold(took, style, chomp, ended);
      continue;
    }

    if (value === "") {
      // A list or a map — decided by the first indented line after it.
      map = {};
      out[key] = map;
    } else {
      // A flow sequence used to be split here and nowhere else, which is why
      // the two positions above read one verbatim. `readValue` is now the
      // only thing that turns text into a value, so all three read it the
      // same way or report the same way.
      out[key] = took(line, readValue(value, "value"));
    }
  }
  return { frontmatter: out, body: text.slice(m[0].length).trim(), framed: true, unread, undecoded };
}

/** One value as this reader made of it, and whether making it was reading it. */
type Scalar = { value: unknown; read: boolean };

/**
 * **Where a value sits, because YAML's plain scalar is a different production
 * in each of the three places this reader finds one** — and the parameter is
 * not optional, so a position that reads a value cannot forget to say which
 * one it is. Mirrors the server's `At`.
 *
 * - `value` — after a `key:`, where a second `: ` is an error to libyaml
 *   rather than a nesting, so there is no reading of it to disagree with.
 * - `item` — a `- ` block sequence item, where a mapping *is* legal, so
 *   `a: b` is a block mapping and one string is not a reading of it.
 * - `flow` — inside `[...]`, where `,` `[` `]` `{` `}` end a plain scalar
 *   wherever they appear.
 *
 * This used to be a boolean `flow`, and the missing third position was a live
 * injection route: `metadata:` / `  - a: "\u003csystem-reminder\u003e"` came
 * back as the one string `a: "\u003cx\u003e"`, so `riskOf` and the `<`/`>`
 * rule were both looking at a frontmatter with no bracket in it while a real
 * reader hands the agent the tag.
 */
type At = "value" | "item" | "flow";

/**
 * A value as this reader makes of it — **and whether that is what a real
 * reader would have done with it**. Mirrors the server's `read_value`.
 *
 * The two cannot be had apart, which is the point. This used to be a
 * `decoded(value)` predicate sitting *beside* `unquote(value)`, re-guessing
 * from the value's first and last characters what `unquote` was about to do,
 * and it had drifted from `unquote` in two of the three positions that read a
 * value: a flow sequence was only ever split at the left margin, so in a
 * nested or a list position the escapes inside one survived with nothing
 * saying so; and `"a\"` ends on a quote that is not a close, so a scalar
 * libyaml had not finished reading looked complete. Both are the server's
 * Blocker, and this file carried them identically — `riskOf` is computed from
 * this parse, so a badge was being drawn from a reading nobody had.
 */
function readValue(raw: string, at: At): Scalar {
  const t = raw.trim();

  const dq = closes(t, '"');
  if (dq !== null) return { value: unescape(dq), read: true };
  const sq = closes(t, "'");
  if (sq !== null) return { value: sq.replace(/''/g, "'"), read: true };

  // `[a, b]`, split the way this reader splits it — and every element put
  // back through here, so an element that is not one scalar is reported by
  // the same answer rather than assumed away by its caller.
  if (t.startsWith("[") && t.endsWith("]")) {
    let read = true;
    const got: unknown[] = [];
    for (const piece of t.slice(1, -1).split(",")) {
      const el = readValue(piece, "flow");
      read = read && el.read;
      if (el.value !== "") got.push(el.value);
    }
    return { value: got, read };
  }
  // The `else`: verbatim, and verbatim is a reading only of a plain scalar.
  return { value: t, read: plain(t, at) };
}

/**
 * `t` as **one complete quoted scalar** — the text between the quotes — or
 * `null`, because it is not that and keeping it whole is not reading it.
 *
 * **The escape is the point.** `"a\"` ends on a quote that is not a close:
 * `\"` is an escaped quote, so for a reader that knows that, the scalar runs
 * on and swallows the next line. Text after the close — `"a" b` — is `null`
 * as well: a reader that ends the scalar at the quote does not then ignore
 * what follows it.
 */
function closes(t: string, q: string): string | null {
  if (!t.startsWith(q)) return null;
  const inner = t.slice(1);
  for (let i = 0; i < inner.length; i++) {
    // In a double-quoted scalar, whatever follows a backslash is spelled
    // rather than structural — including a quote.
    if (q === '"' && inner[i] === "\\") {
      i++;
      continue;
    }
    if (inner[i] !== q) continue;
    // `''` inside a single-quoted scalar is one quote, not the close.
    if (q === "'" && inner[i + 1] === q) {
      i++;
      continue;
    }
    return i === inner.length - 1 ? inner.slice(0, i) : null;
  }
  return null;
}

/**
 * Whether `t` is something YAML reads as a **plain scalar** — the one shape
 * whose reading is its spelling, because a plain scalar has no escapes.
 *
 * The rule is the standard's `ns-plain-first` rather than a list of the
 * shapes that have bitten: a plain scalar may not *begin* with an indicator,
 * and `-`, `?` and `:` are indicators only when a space or the end of the
 * value follows. Inside a flow collection the same production also forbids
 * `,`, `[`, `]`, `{` and `}` anywhere in the scalar.
 *
 * **And a `: ` ends a plain scalar and makes the element a mapping wherever a
 * mapping is legal** — a flow collection *and* a block sequence item. Reading
 * that as a flow-only rule is what let a `- a: "\u003c…"` item through
 * undecoded; the negative control names the cause, since `- a:"\u003cx\u003e"`
 * with no space really is a plain scalar and is correctly accepted.
 *
 * Stated as the complement, which is what makes it fail closed: a flow
 * mapping, a tag, an anchor, an alias and a directive are all refused
 * without being named, and so is the next one.
 */
function plain(t: string, at: At): boolean {
  if (t === "") return true;
  const first = t[0]!;
  if ("-?:".includes(first)) {
    if (t.length === 1 || t[1] === " " || t[1] === "\t") return false;
  } else if (",[]{}#&*!|>'\"%@`".includes(first)) {
    return false;
  }
  // The flow indicators, which end a plain scalar only inside `[...]`.
  if (at === "flow" && /[,[\]{}]/.test(t)) return false;
  // `: ` — a mapping, wherever a mapping is legal, and `"value"` is the one
  // place it is not.
  if (at !== "value" && (t.includes(": ") || t.endsWith(":"))) return false;
  return true;
}

/**
 * The lines of a block scalar, joined the way its style says.
 *
 * `|` keeps every break. `>` folds a single break into a space and a blank
 * line into one break, and leaves a more-indented line alone — which is what
 * makes a long `description: >` read as one paragraph. Chomping decides the
 * trailing newlines: `-` drops them, `+` keeps them all, and the default
 * keeps one *if the file had one* — a block that is the last thing before the
 * closing `---` has no break after it to keep. Checked against libyaml.
 *
 * Every caller here trims, so the tail only matters for agreeing with a real
 * YAML parser rather than for what ends up stored.
 */
function fold(
  got: string[],
  style: "|" | ">",
  chomp: "strip" | "clip" | "keep",
  ended: boolean,
): string {
  const kept = [...got];
  let trailing = 0;
  while (kept.length && !kept[kept.length - 1]!.trim()) {
    kept.pop();
    trailing++;
  }
  if (!kept.length) return "";
  const breaks = trailing + (ended ? 1 : 0);

  let text: string;
  if (style === "|") {
    text = kept.join("\n");
  } else {
    const joined: string[] = [];
    for (const l of kept) {
      const prev = joined[joined.length - 1];
      const foldable =
        prev !== undefined && prev.trim() !== "" && !/^\s/.test(prev) && !/^\s/.test(l) && l.trim() !== "";
      if (foldable) joined[joined.length - 1] = `${prev} ${l.trim()}`;
      else joined.push(l);
    }
    // A blank line between two folded runs is one break, not two.
    text = joined.join("\n").replace(/\n{2,}/g, (run) => run.slice(1));
  }

  if (chomp === "keep") text += "\n".repeat(breaks);
  else if (chomp === "clip" && breaks > 0) text += "\n";
  return text;
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

/**
 * YAML's double-quoted escapes. Anything else is left as it was written.
 *
 * **The escapes are the point, not a nicety.** A double-quoted scalar may
 * spell any character as `\uXXXX`, so `description: "\u003csystem-reminder\u003e"`
 * holds no `<` for the rule above to find — and then the agent, which reads
 * `SKILL.md` with a real YAML parser, renders the tag. Stripping the quotes
 * without decoding what is inside them makes the rule advice rather than a
 * check.
 */
function unescape(s: string): string {
  return s.replace(
    /\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|x[0-9a-fA-F]{2}|.)/gs,
    (all: string, esc: string) => {
      if (esc[0] === "u" || esc[0] === "U" || esc[0] === "x")
        return String.fromCodePoint(parseInt(esc.slice(1), 16));
      const one: Record<string, string> = {
        "0": "\0", a: "\x07", b: "\b", t: "\t", "\t": "\t", n: "\n", v: "\v",
        f: "\f", r: "\r", e: "\x1b", " ": " ", '"': '"', "/": "/", "\\": "\\",
        N: "", _: " ", L: " ", P: " ",
      };
      return one[esc] ?? all;
    },
  );
}

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
export function size(bytes: number | null | undefined): string {
  /* **`NaN MB` is worse than nothing.** A server that does not carry a byte
     count — an older one, or a skill that has not been measured — printed
     "NaN MB" into a facts table, which reads as the app being broken rather
     than as a figure being absent. */
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/** Whether two lists of ids hold the same set. */
export const sameSet = (a: Iterable<string>, b: Iterable<string>) => {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((v) => y.has(v));
};

/**
 * Where a session's selection came from, in a few words, or null when it is
 * not simply its defaults: `firetower defaults`, `defaults from 2 repos`.
 */
export function fromDefaults(
  selected: string[],
  repos: { slug: string; defaults: string[] }[],
  alwaysOn: string[],
): string | null {
  const giving = repos.filter((r) => r.defaults.length > 0);
  const expected = [...giving.flatMap((r) => r.defaults), ...alwaysOn];
  if (selected.length === 0 || expected.length === 0 || !sameSet(selected, expected)) return null;
  if (giving.length === 0) return "always on";
  if (giving.length === 1) return `${giving[0]!.slug.split("/").pop()} defaults`;
  return `defaults from ${giving.length} repos`;
}

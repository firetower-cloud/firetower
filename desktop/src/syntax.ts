/**
 * Just enough highlighting to read code by.
 *
 * Not a parser. A parser is the right answer for an editor and the wrong one
 * for a viewer: what a reader needs is for strings, comments and keywords to
 * stop looking like identifiers, and a few ordered regexes do that for every
 * language here without carrying a grammar per language.
 *
 * Ordered on purpose — comments and strings are matched first, so a keyword
 * inside a comment stays a comment.
 */
export type Kind = "comment" | "string" | "keyword" | "type" | "number" | "fn" | "attr" | "plain";

export type Piece = { text: string; kind: Kind };

const KEYWORDS: Record<string, string[]> = {
  rust: "pub fn let const mut use struct enum impl match if else for while loop return async await move ref where trait self crate super mod as in dyn type unsafe".split(" "),
  ts: "import export from const let var function return if else for while class extends interface type await async new try catch throw of in typeof as default".split(" "),
  sql: "create table index unique references on delete cascade not null primary key default text timestamptz boolean select insert into values from where drop alter add".split(" "),
  toml: [],
  make: [],
  text: [],
};

const TYPES: Record<string, RegExp> = {
  rust: /\b(String|Option|Result|Vec|Duration|Arc|Self|Json|State|[A-Z][A-Za-z0-9_]*)\b/,
  ts: /\b([A-Z][A-Za-z0-9_]*)\b/,
  sql: /$^/,
  toml: /$^/,
  make: /$^/,
  text: /$^/,
};

function rules(lang: string): [RegExp, Kind][] {
  const comment =
    lang === "sql" ? /^--[^\n]*/ : lang === "toml" || lang === "make" ? /^#[^\n]*/ : /^\/\/[^\n]*/;

  const words = KEYWORDS[lang] ?? [];
  const keyword = words.length
    ? new RegExp(`^\\b(${words.join("|")})\\b`, lang === "sql" ? "i" : "")
    : /$^/;

  return [
    [comment, "comment"],
    [/^"(?:[^"\\]|\\.)*"/, "string"],
    [/^'(?:[^'\\]|\\.)*'/, "string"],
    [/^`(?:[^`\\]|\\.)*`/, "string"],
    [/^#\[[^\]]*\]/, "attr"],
    [keyword, "keyword"],
    [/^\b\d[\d_.]*\b/, "number"],
    [/^\b([a-z_][A-Za-z0-9_]*)(?=\s*\()/, "fn"],
    [new RegExp(`^${TYPES[lang]?.source ?? "$^"}`), "type"],
  ];
}

/** One line, split into coloured pieces. */
export function highlight(line: string, lang: string): Piece[] {
  const table = rules(lang);
  const out: Piece[] = [];
  let rest = line;
  let plain = "";

  const flush = () => {
    if (plain) out.push({ text: plain, kind: "plain" });
    plain = "";
  };

  while (rest) {
    let hit: Piece | null = null;
    for (const [re, kind] of table) {
      const m = re.exec(rest);
      if (m && m[0]) {
        hit = { text: m[0], kind };
        break;
      }
    }

    if (hit) {
      flush();
      out.push(hit);
      rest = rest.slice(hit.text.length);
    } else {
      plain += rest[0];
      rest = rest.slice(1);
    }
  }

  flush();
  return out;
}

export const TONE: Record<Kind, string> = {
  comment: "text-syn-comment",
  string: "text-syn-string",
  keyword: "text-syn-keyword",
  type: "text-syn-type",
  number: "text-syn-number",
  fn: "text-syn-fn",
  attr: "text-syn-attr",
  plain: "text-text",
};

/** From a path, since fixtures do not always carry a language. */
export function langOf(path: string): string {
  if (path.endsWith(".rs")) return "rust";
  if (path.endsWith(".sql")) return "sql";
  if (/\.(ts|tsx|js|jsx)$/.test(path)) return "ts";
  if (path.endsWith(".toml")) return "toml";
  if (/justfile|makefile|\.sh$/i.test(path)) return "make";
  return "text";
}

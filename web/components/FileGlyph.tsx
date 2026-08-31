/**
 * What kind of file this is, as a shape and a colour.
 *
 * The tree used to have three shapes doing every job — a triangle for a
 * directory, a square for everything else, an arrow for a link — which meant a
 * lockfile, a README and a source file were indistinguishable until you read
 * their names. A glyph per kind lets somebody find the file they want by
 * silhouette, which is how anybody actually reads a file tree.
 *
 * Colour does the same job one step faster: at a glance a panel of Rust is
 * amber and a panel of config is sand, and the eye lands on the odd one out
 * before it has read a single name. The tints live in their own namespace in
 * `globals.css` and sit below the signal colours in saturation — four hundred
 * rows must not be able to out-shout the one thing that means an agent is
 * waiting on you.
 *
 * Kept to nine kinds on purpose. One per extension is a maintenance burden and,
 * past a handful, stops helping — the point is separating *categories* a person
 * is looking for, not labelling every format.
 */

import {
  Braces,
  ChevronRight,
  Code2,
  Database,
  FileCode2,
  FileText,
  Image,
  Link2,
  Lock,
  Palette,
  type LucideIcon,
} from "lucide-react";
import { Icon } from "./ui";

type Kind =
  | "dir"
  | "source"
  | "native"
  | "data"
  | "style"
  | "media"
  | "store"
  | "prose"
  | "lock"
  | "link";

/** One glyph and one tint per kind. */
const GLYPH: Record<Kind, { icon: LucideIcon; tone: string }> = {
  // A chevron rather than a folder: it is also the control that opens it, so it
  // should look like a thing with two states.
  dir: { icon: ChevronRight, tone: "text-dim" },
  link: { icon: Link2, tone: "text-dim" },
  source: { icon: Code2, tone: "text-kind-source" },
  native: { icon: FileCode2, tone: "text-kind-native" },
  data: { icon: Braces, tone: "text-kind-data" },
  style: { icon: Palette, tone: "text-kind-style" },
  media: { icon: Image, tone: "text-kind-media" },
  store: { icon: Database, tone: "text-kind-store" },
  prose: { icon: FileText, tone: "text-kind-prose" },
  // Generated, and not for reading. It says "leave this alone".
  lock: { icon: Lock, tone: "text-mute" },
};

export function FileGlyph({
  name,
  directory,
  link,
  open = false,
  size = 14,
  className = "",
}: {
  name: string;
  directory?: boolean;
  link?: boolean;
  /** A directory that is expanded, so the chevron can point at what it did. */
  open?: boolean;
  size?: 12 | 14;
  className?: string;
}) {
  const kind: Kind = link ? "link" : directory ? "dir" : kindOf(name);
  const { icon, tone } = GLYPH[kind];

  return (
    <span
      style={kind === "dir" && open ? { transform: "rotate(90deg)" } : undefined}
      className={`inline-flex shrink-0 transition-transform ${tone} ${className}`}
    >
      <Icon of={icon} size={size} />
    </span>
  );
}

const PROSE = /\.(md|markdown|mdx|txt|rst|adoc)$/i;
const DATA = /\.(json|jsonc|ya?ml|toml|ini|conf|env|properties|lock|xml|csv)$/i;
const STYLE = /\.(css|scss|sass|less|styl)$/i;
const MEDIA = /\.(png|jpe?g|gif|svg|webp|avif|ico|bmp|mp4|mov|webm|woff2?|ttf|otf)$/i;
const STORE = /\.(sql|db|sqlite3?|prisma)$/i;
/** Compiled, and close to the machine — the half of a repo that is a binary. */
const NATIVE = /\.(rs|c|h|cc|cpp|hpp|cs|go|swift|kt|kts|java|zig|m|mm)$/i;
const SOURCE =
  /\.(tsx?|jsx?|mjs|cjs|py|rb|php|pl|lua|ex|exs|sh|bash|zsh|fish|vue|svelte|html?|astro)$/i;

/** Generated files nobody edits by hand, matched whole rather than by suffix. */
const LOCKS = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "cargo.lock",
  "gemfile.lock",
  "poetry.lock",
  "bun.lockb",
  "composer.lock",
  "go.sum",
  "flake.lock",
]);

/** Prose that arrives without an extension, and is prose all the same. */
const BARE = new Set(["license", "licence", "readme", "notice", "authors", "changelog"]);

function kindOf(name: string): Kind {
  const lower = name.toLowerCase();

  // Before the extension tests: a lockfile is YAML or JSON, and saying so is
  // less useful than saying it is generated.
  if (LOCKS.has(lower)) return "lock";
  if (BARE.has(lower)) return "prose";
  if (PROSE.test(name)) return "prose";
  if (MEDIA.test(name)) return "media";
  if (STYLE.test(name)) return "style";
  if (STORE.test(name)) return "store";
  if (NATIVE.test(name)) return "native";
  if (SOURCE.test(name)) return "source";
  if (DATA.test(name)) return "data";
  // A dotfile with no extension — `.gitignore`, `.npmrc` — is configuration.
  if (name.startsWith(".") && !name.slice(1).includes(".")) return "data";
  return "prose";
}

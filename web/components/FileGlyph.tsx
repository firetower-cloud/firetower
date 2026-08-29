/**
 * What kind of file this is, as a shape.
 *
 * The tree used to have three shapes doing every job — a triangle for a
 * directory, a square for everything else, an arrow for a link — which meant a
 * lockfile, a README and a source file were indistinguishable until you read
 * their names. A glyph per kind lets somebody find the file they want by
 * silhouette, which is how anybody actually reads a file tree.
 *
 * Kept to six kinds on purpose. One per extension is a maintenance burden and,
 * past a handful, stops helping — the point is separating *categories* a person
 * is looking for, not labelling every format.
 */

import {
  Braces,
  ChevronRight,
  Code2,
  FileText,
  Image,
  Link2,
  Lock,
  type LucideIcon,
} from "lucide-react";
import { Icon } from "./ui";

type Kind = "dir" | "doc" | "code" | "config" | "image" | "lock" | "link";

/** One glyph and one tint per kind. Everything else in the tree stays grey. */
const GLYPH: Record<Kind, { icon: LucideIcon; tone: string }> = {
  // A chevron rather than a folder: it is also the control that opens it, so it
  // should look like a thing with two states.
  dir: { icon: ChevronRight, tone: "text-dim" },
  link: { icon: Link2, tone: "text-dim" },
  doc: { icon: FileText, tone: "text-dim" },
  code: { icon: Code2, tone: "text-slate" },
  config: { icon: Braces, tone: "text-dim" },
  image: { icon: Image, tone: "text-sage" },
  // Generated, and not for reading. It says "leave this alone".
  lock: { icon: Lock, tone: "text-mute" },
};

export function FileGlyph({
  name,
  directory,
  link,
  open = false,
  size = 12,
  className = "",
}: {
  name: string;
  directory?: boolean;
  link?: boolean;
  /** A directory that is expanded, so the chevron can point at what it did. */
  open?: boolean;
  size?: number;
  className?: string;
}) {
  const kind: Kind = link ? "link" : directory ? "dir" : kindOf(name);
  const { icon, tone } = GLYPH[kind];

  return (
    <span
      style={kind === "dir" && open ? { transform: "rotate(90deg)" } : undefined}
      className={`inline-flex shrink-0 transition-transform ${tone} ${className}`}
    >
      <Icon of={icon} size={size === 12 ? 12 : 14} />
    </span>
  );
}

const DOC = /\.(md|markdown|mdx|txt|rst|adoc)$/i;
const CONFIG = /\.(json|jsonc|ya?ml|toml|ini|conf|env|properties)$/i;
const IMAGE = /\.(png|jpe?g|gif|svg|webp|avif|ico|bmp)$/i;
const CODE =
  /\.(rs|tsx?|jsx?|mjs|cjs|py|go|rb|java|kt|swift|c|h|cpp|hpp|cs|php|sh|bash|zsh|sql|css|scss|html?|vue|svelte)$/i;

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
]);

function kindOf(name: string): Kind {
  // Before the extension tests: a lockfile is YAML or JSON, and saying so is
  // less useful than saying it is generated.
  if (LOCKS.has(name.toLowerCase())) return "lock";
  if (DOC.test(name)) return "doc";
  if (IMAGE.test(name)) return "image";
  if (CODE.test(name)) return "code";
  if (CONFIG.test(name)) return "config";
  // A dotfile with no extension — `.gitignore`, `.npmrc` — is configuration.
  if (name.startsWith(".") && !name.slice(1).includes(".")) return "config";
  return "doc";
}

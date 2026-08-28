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

type Kind = "dir" | "doc" | "code" | "config" | "image" | "lock" | "link";

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

  const common = {
    width: size,
    height: size,
    viewBox: "0 0 12 12",
    fill: "none",
    stroke: "currentColor",
    "aria-hidden": true,
    className,
  } as const;

  switch (kind) {
    case "dir":
      // A chevron rather than a folder: it is also the control that opens it,
      // so it should look like a thing with two states.
      return (
        <svg {...common} style={{ transform: open ? "rotate(90deg)" : undefined }}>
          <path d="M4.5 2.5L8 6l-3.5 3.5" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );

    case "link":
      return (
        <svg {...common}>
          <path d="M3.5 8.5L8.5 3.5M5.5 3.5h3v3" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );

    // Prose. A paragraph mark, because that is what is inside.
    case "doc":
      return (
        <svg {...common}>
          <path d="M2.5 3h7M2.5 6h7M2.5 9h4" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      );

    // Source. Angle brackets.
    case "code":
      return (
        <svg {...common}>
          <path d="M4.2 3.6L1.8 6l2.4 2.4M7.8 3.6L10.2 6L7.8 8.4" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );

    // Settings. Braces.
    case "config":
      return (
        <svg {...common}>
          <path
            d="M4.6 2.5c-1 0-1.3.5-1.3 1.4v1c0 .7-.3 1.1-1.1 1.1.8 0 1.1.4 1.1 1.1v1c0 .9.3 1.4 1.3 1.4M7.4 2.5c1 0 1.3.5 1.3 1.4v1c0 .7.3 1.1 1.1 1.1-.8 0-1.1.4-1.1 1.1v1c0 .9-.3 1.4-1.3 1.4"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </svg>
      );

    case "image":
      return (
        <svg {...common}>
          <rect x="1.8" y="2.5" width="8.4" height="7" rx="1.2" strokeWidth="1.2" />
          <circle cx="4.4" cy="5" r=".8" strokeWidth="1.1" />
          <path d="M2.4 8.4L4.8 6.4l2 1.6 1.6-1.2 1.4 1.1" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );

    // Generated, and not for reading. A closed padlock body — it says "leave
    // this alone" without needing to be legible as anything specific.
    case "lock":
      return (
        <svg {...common}>
          <rect x="2.6" y="5.2" width="6.8" height="4.4" rx="1" strokeWidth="1.2" />
          <path d="M4.2 5.2V4a1.8 1.8 0 013.6 0v1.2" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      );
  }
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

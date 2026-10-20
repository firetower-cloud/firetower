import { GitBranch } from "lucide-react";

/**
 * Brand marks.
 *
 * The icon set does not carry logos — a brand mark is a fixed shape somebody
 * else owns, not a glyph that can be redrawn at a different stroke weight. So
 * these live apart from `Icon`, filled rather than stroked, and nothing else
 * in the app is allowed to look like them.
 */
export function GithubMark({ size = 14, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden
      className={`shrink-0 ${className}`}
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.42 7.42 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

/**
 * GitLab's mark: the tanuki, as the five-fold fox face.
 *
 * One path, because unlike Linear's the shape is a solid silhouette — the
 * notches between the tines are part of the outline rather than gaps between
 * subpaths, so it holds together at 12px where four pieces would not.
 */
export function GitLabMark({ size = 14, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      className={`shrink-0 ${className}`}
    >
      <path d="M23.955 13.587l-1.342-4.135-2.664-8.189a.455.455 0 0 0-.867 0L16.418 9.45H7.582L4.918 1.263a.455.455 0 0 0-.867 0L1.386 9.452.044 13.587a.924.924 0 0 0 .331 1.03L12 23.054l11.625-8.436a.92.92 0 0 0 .33-1.031" />
    </svg>
  );
}

/**
 * Gitea's mark: the teacup, reduced to the cup, the handle and the steam.
 *
 * Drawn rather than taken from the official asset, which is a full-colour
 * illustration — these are all one `currentColor` glyph so a row can tint them
 * together with the text beside it.
 */
export function GiteaMark({ size = 14, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      className={`shrink-0 ${className}`}
    >
      <path d="M3 9h12v5a5 5 0 0 1-5 5H8a5 5 0 0 1-5-5V9Zm13 1h1.5a3.5 3.5 0 0 1 0 7H16v-2h1.5a1.5 1.5 0 0 0 0-3H16v-2ZM4 20.5h11a.75.75 0 0 1 0 1.5H4a.75.75 0 0 1 0-1.5ZM7.4 2c.2 1 .05 1.76-.45 2.3-.6.64-.76 1.5-.45 2.45l-1.4.5c-.5-1.5-.22-2.85.7-3.84.3-.32.37-.72.2-1.26L7.4 2Zm4 0c.2 1 .05 1.76-.45 2.3-.6.64-.76 1.5-.45 2.45l-1.4.5c-.5-1.5-.22-2.85.7-3.84.3-.32.37-.72.2-1.26L11.4 2Z" />
    </svg>
  );
}

/**
 * The mark for a git host, by kind.
 *
 * One lookup rather than a `GithubMark` hard-coded into every row that draws a
 * repository — which is what there was, in thirteen places, and what made a
 * GitLab project appear under GitHub's logo. An unknown kind gets the generic
 * branch glyph: a host this build has never heard of is a row to draw, not a
 * row to guess the brand of.
 */
export function HostMark({
  kind,
  size = 14,
  className = "",
  brand = false,
}: {
  kind?: string | null;
  size?: number;
  className?: string;
  /**
   * Draw it in the host's own colour rather than inheriting the text's.
   *
   * For the few places a logo is doing the work of being *found* rather than
   * read — the empty state's host buttons, the host picker. Everywhere else a
   * mark sits in a dense row beside a slug and should be as quiet as the text
   * around it, which is why this is off by default.
   */
  brand?: boolean;
}) {
  const tint = brand ? BRAND[kind ?? ""] ?? "" : "";
  const look = `${tint} ${className}`.trim();

  if (kind === "gitlab") return <GitLabMark size={size} className={look} />;
  if (kind === "gitea") return <GiteaMark size={size} className={look} />;
  if (kind === "github") return <GithubMark size={size} className={look} />;
  return <GitBranch size={size} strokeWidth={1.75} className={`shrink-0 ${look}`} />;
}

/** Defined as tokens in `globals.css`, so the palette is in one place. */
const BRAND: Record<string, string> = {
  github: "text-host-github",
  gitlab: "text-host-gitlab",
  gitea: "text-host-gitea",
};

/**
 * Linear's mark: a rounded square sliced into four diagonal bands.
 *
 * Four subpaths rather than one, because the shape *is* the gaps between them
 * — drawn as a single outline it fills in at small sizes and reads as a blob.
 */
export function LinearMark({ size = 14, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      className={`shrink-0 ${className}`}
    >
      <path d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18Z" />
      <path d="M1.5 6.132a11.943 11.943 0 0 0-1.29 3.6l14.897 14.896a11.944 11.944 0 0 0 3.598-1.29L1.5 6.132Z" />
      <path d="M.007 12.998a11.962 11.962 0 0 0 .714 3.58l6.701 6.701a11.963 11.963 0 0 0 3.58.714L.007 12.998Z" />
      <path d="M3.37 23.679.32 20.63a12.014 12.014 0 0 0 3.05 3.049Z" />
    </svg>
  );
}

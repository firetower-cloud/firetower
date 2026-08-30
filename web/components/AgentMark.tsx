import type { Agent } from "@/src/api/generated/model";

/**
 * Which agent, as a shape rather than a word.
 *
 * Every row that names an agent used to spend a line on the lowercase string
 * `claudecode`, which is both the least interesting thing about the row and the
 * hardest part of it to skim. A mark is read at a glance and costs no width, so
 * the line underneath can say something worth reading instead.
 *
 * Drawn rather than fetched. These sit in a rail that renders on every poll,
 * they have to tint with the row they are in, and an interface that is meant to
 * build offline cannot go to somebody's CDN for a logo.
 *
 * Deliberately *not* the vendors' logos. These are our own glyphs standing for
 * "the thing with the star" and "the thing with the rings" — close enough to
 * tell apart at 14px, and not a trademark we are redistributing.
 */
export function AgentMark({
  agent,
  size = 14,
  className = "",
}: {
  agent: Agent;
  size?: number;
  className?: string;
}) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    "aria-hidden": true,
    className,
  } as const;

  switch (agent) {
    // A burst. Six spokes, because four reads as a plus sign and eight fills in
    // to a blob at the size this is actually used.
    case "ClaudeCode":
      return (
        <svg {...common}>
          <g strokeWidth="1.4" strokeLinecap="round">
            <path d="M8 2.2v11.6M3 5.1l10 5.8M13 5.1L3 10.9" />
          </g>
        </svg>
      );

    // A ring with a gap, on its side. Distinct from the burst in silhouette,
    // which is the only property that matters in a list.
    case "Codex":
      return (
        <svg {...common}>
          <path
            d="M13.2 8a5.2 5.2 0 11-2.6-4.5"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <circle cx="8" cy="8" r="1.6" strokeWidth="1.4" />
        </svg>
      );

    // A prompt. Nothing is driving this one.
    case "Shell":
    default:
      return (
        <svg {...common}>
          <path
            d="M4 4.5L7.5 8L4 11.5M8.5 11.5h3.5"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
  }
}

/** What to call one, where there is room for the name. */
export const AGENT_LABEL: Record<Agent, string> = {
  ClaudeCode: "Claude Code",
  Codex: "Codex",
  Shell: "Shell",
};

/** The short form, for a line that already says plenty. */
export const AGENT_SHORT: Record<Agent, string> = {
  ClaudeCode: "claude",
  Codex: "codex",
  Shell: "shell",
};

import type { Agent } from "~/api/generated/model";

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
 * These are the providers' own marks, drawn as paths rather than fetched, and
 * filled with `currentColor` so they tint with the row they sit in. Used to
 * say which tool is running in a workspace, which is what a mark is for; the
 * names and the marks belong to their owners.
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
    /* Claude's burst: rays from a common centre, twelve of them at thirty
       degrees apart, the longer ones on the diagonals. Drawn with `rotate`
       rather than as twelve sets of coordinates, so the spacing is exact and
       the shape stays symmetric if the weight is ever changed. */
    case "ClaudeCode":
      return (
        <svg {...common}>
          <g strokeWidth="1.25" strokeLinecap="round">
            {[0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].map((deg) => (
              <path
                key={deg}
                d={deg % 60 === 0 ? "M8 1.6V5.2" : "M8 2.7V5.4"}
                transform={`rotate(${deg} 8 8)`}
              />
            ))}
          </g>
        </svg>
      );

    /* OpenAI's knot, as six lobes around a centre. The real mark is one
       continuous interlaced path; at twelve pixels what survives of it is the
       six-fold silhouette, which is what this keeps. */
    case "Codex":
      return (
        <svg {...common}>
          <g strokeWidth="1.2" strokeLinecap="round">
            {[0, 60, 120, 180, 240, 300].map((deg) => (
              <path
                key={deg}
                d="M8 2.9a3.1 3.1 0 012.7 4.65"
                transform={`rotate(${deg} 8 8)`}
              />
            ))}
          </g>
        </svg>
      );

    // A prompt. Nothing is driving this one, so it gets no logo.
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

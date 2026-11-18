/**
 * What changed, across every version being jumped.
 *
 * General access skips versions as a matter of course, so the newest
 * release's notes are the wrong answer on most upgrades. One row per version,
 * collapsed to its first subject and opening to its section, assembled per
 * package.
 *
 * **The list scrolls and the shortfall does not.** Past about eight rows the
 * rows take their own scroll rather than pushing the panel's primary action
 * off the page — a panel taller than a short window may not rely on being
 * seen whole. The shortfall sits under that scroll, because a count somebody
 * has to scroll to is a count they do not see.
 *
 * **Never silently short.** When the read stopped at the cap, the boundary is
 * named and the full comparison is linked. A list that looks complete and is
 * not is worse than showing one version.
 */
import { useState } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { Icon } from "~/components/ui";
import type { Span } from "~/releases";
import { PACKAGE_NAME, bullets, counts, firstSubject, PAGES, on } from "~/releases";

/** How many bullets a version shows before it says how many more there are. */
const SHOWN = 4;

export function ChangelogSpan({
  span,
  pending,
  /** The rows take their own scroll past this many. */
  tall = 8,
}: {
  span: Span | null;
  pending: boolean;
  tall?: number;
}) {
  const [open, setOpen] = useState<string[]>([]);
  if (pending) {
    return (
      <p className="why flex items-center gap-2">
        <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} />
        Reading what changed…
      </p>
    );
  }
  if (!span) return null;

  const flip = (v: string) =>
    setOpen(open.includes(v) ? open.filter((x) => x !== v) : [...open, v]);

  return (
    <div className={`span${span.versions.length > tall ? " tall" : ""}`}>
      <div className="pkg">
        <b>{PACKAGE_NAME[span.package]}</b>
        <span>
          {span.versions.length === 0
            ? `${span.from} to ${span.to}`
            : `${span.versions.length} ${span.versions.length === 1 ? "version" : "versions"}, ${span.from} to ${span.to}`}
        </span>
      </div>
      <div className="rows">
        {span.versions.map((v) => {
          const showing = open.includes(v.version);
          const lines = showing ? bullets(v.notes) : [];
          return (
            <div key={v.version}>
              <button
                type="button"
                onClick={() => flip(v.version)}
                aria-expanded={showing}
                className="vrow"
              >
                <span className="cv">
                  <Icon of={showing ? ChevronDown : ChevronRight} size={12} />
                </span>
                <span className="vn">{v.version}</span>
                <span className="sm">
                  {(showing ? counts(v.notes) : firstSubject(v.notes)) ?? "no notes published"}
                </span>
                <span className="dt">{on(v.publishedAt)}</span>
              </button>
              {showing && (
                <div className="body">
                  {lines.length === 0 ? (
                    <p className="text-ui text-dim">This release published no notes.</p>
                  ) : (
                    <ul>
                      {lines.slice(0, SHOWN).map((line, i) => (
                        <li key={i}>{line}</li>
                      ))}
                      {lines.length > SHOWN && (
                        <li className="text-dim">
                          and {lines.length - SHOWN} more in this release
                        </li>
                      )}
                    </ul>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {(span.shortfallBelow || span.trouble || span.versions.length === 0) && (
        <div className="short">
          <span className="vn" />
          <p>
            {span.trouble
              ? `${span.trouble} `
              : span.shortfallBelow
                ? `Versions between ${span.from} and ${span.shortfallBelow} are not shown. The releases feed is read ${PAGES} pages deep, which is where the sections stop. `
                : "No release notes were found for this jump. "}
            <a className="linkish" href={span.compareHref} target="_blank" rel="noreferrer">
              Compare {span.from} with {span.to}
            </a>
          </p>
        </div>
      )}
    </div>
  );
}

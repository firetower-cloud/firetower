"use client";

/**
 * Everything you set up once.
 *
 * Agents, secrets, hosts and repositories were four rows at the top of the
 * rail, level with the work — which made the rail read as a settings menu with
 * some sessions underneath. They are not the same kind of thing as a workspace:
 * you touch them on the first day and then not again until something breaks.
 *
 * One page, four sections. The sections are the pages that already existed,
 * rendered here rather than rewritten — their routes still work, so a link
 * anybody has kept is not broken by the move.
 */

import { useEffect, useState } from "react";
import Agents from "@/app/agents/page";
import Repos from "@/app/repos/page";
import Secrets from "@/app/secrets/page";
import Compute from "@/app/compute/page";

const SECTIONS = [
  { id: "agents", label: "Agents" },
  { id: "repositories", label: "Repositories" },
  { id: "secrets", label: "Secrets" },
  { id: "compute", label: "Compute" },
] as const;

type Section = (typeof SECTIONS)[number]["id"];

const isSection = (value: string): value is Section =>
  SECTIONS.some((s) => s.id === value);

export default function Configuration() {
  const [showing, setShowing] = useState<Section>("agents");

  // Addressed by fragment rather than by route: these are four views of one
  // page, and the rail's "connect a repository" has to be able to land on the
  // right one. A fragment also survives the static export without a second
  // dynamic route to enumerate.
  useEffect(() => {
    const read = () => {
      const asked = window.location.hash.replace("#", "");
      if (isSection(asked)) setShowing(asked);
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);

  return (
    <div className="px-8 pt-6 pb-24">
      {/* No heading of its own: each section brings one, and two stacked
          headings saying the same word is the page apologising for existing. */}
      <nav className="mb-2 flex gap-1 border-b border-line">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            onClick={() => {
              setShowing(s.id);
              window.history.replaceState(null, "", `#${s.id}`);
            }}
            className={`-mb-px border-b-2 px-3 py-2 text-ui transition-colors ${
              s.id === showing
                ? "border-bone text-bone"
                : "border-transparent text-mute hover:text-text"
            }`}
          >
            {s.label}
          </button>
        ))}
      </nav>

      {/* The four pages that already existed, rendered rather than rewritten —
          each keeps its own heading and copy, and its own route still works, so
          a link anybody kept is not broken by the move. */}
      <div className="-mt-4">
        {showing === "agents" && <Agents />}
        {showing === "repositories" && <Repos />}
        {showing === "secrets" && <Secrets />}
        {showing === "compute" && <Compute />}
      </div>
    </div>
  );
}

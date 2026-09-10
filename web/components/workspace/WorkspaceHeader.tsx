"use client";

/**
 * Where you are, how you get back, and which of the three you are looking at.
 *
 * Only below `xl`. Above it the rail names the workspace, the panel holds the
 * views, and a header would be a row of chrome restating the room — which is
 * exactly the bar that was deleted from `SessionTab`, and it is not coming
 * back to the desk.
 *
 * Below `xl` none of that is on screen. There is no rail to say which
 * workspace this is, no panel to reach Ship from, and — on a phone — no
 * browser chrome to press Back in, because the address bar hides itself the
 * moment you scroll. So this is the whole of the furniture, in one 52px bar
 * and one 40px row.
 *
 * ## The switcher is at the top
 *
 * A bottom tab bar is the obvious mobile answer and it is wrong here, because
 * the bottom is spoken for. The composer lives there, it is 90px, and a 44px
 * bar under it is 134px of chrome beneath a transcript on a screen with about
 * 300px left above the keyboard. Switching view happens a few times an hour
 * and typing happens constantly, so the frequent thing keeps the reachable
 * place. It is also where the desk draws its tab strip, which makes this one
 * idea at two sizes rather than two ideas.
 */

import { useState } from "react";
import { ChevronLeft, Menu, MoreHorizontal } from "lucide-react";
import { useGetSession } from "@/src/api/generated/sessions/sessions";
import { Icon } from "@/components/ui";
import { Signal } from "@/components/Signal";
import { useDrawer } from "@/src/workspace/drawer";
import { useHasRail } from "@/src/workspace/layout";
import { SCREENS, useScreen } from "@/src/workspace/screen";
import { WorkspaceMenu } from "./WorkspaceMenu";
import { StatusSheet } from "./StatusSheet";

export function WorkspaceHeader({
  sessionId,
  changed,
  onBack,
}: {
  sessionId: string;
  /** How many files the agent has touched, for the count on `Diff`. */
  changed: number;
  onBack: () => void;
}) {
  const { data: session } = useGetSession(sessionId);
  const { show: openDrawer } = useDrawer();
  const hasRail = useHasRail();
  const [menu, setMenu] = useState(false);
  const [status, setStatus] = useState(false);

  return (
    <header className="shrink-0 border-b border-line bg-panel pt-[env(safe-area-inset-top)]">
      <div className="flex h-13 items-center gap-0.5 px-1">
        {/* Back on a phone, the menu on a tablet.
            They are the same button in the same place doing the same job —
            "out of here" — and which one it is depends on whether there is
            already a rail on screen to go out *to*. A `‹` beside a rail that
            is permanently showing the fleet would be a second way to do what
            the rail does. */}
        {hasRail ? (
          <Tap label="Open the menu" onClick={openDrawer}>
            <Icon of={Menu} size={16} />
          </Tap>
        ) : (
          <Tap label="Back to the dashboard" onClick={onBack}>
            <Icon of={ChevronLeft} size={20} />
          </Tap>
        )}

        <div className="min-w-0 flex-1 px-1">
          <p className="truncate text-ui font-medium text-bone">
            {session?.name ?? "Workspace"}
          </p>
          <p className="truncate font-mono text-micro text-mute">
            {session?.repo ?? session?.branch ?? "no repository"}
          </p>
        </div>

        {/* The light is a button. What the session is doing lives at the foot
            of the panel on a desk, and the panel is not here — so the thing
            that already means "state" is what opens it. */}
        <Tap label="What this session is doing" onClick={() => setStatus(true)}>
          <Signal status={session?.status ?? "Starting"} size={8} />
        </Tap>

        <Tap label="More" onClick={() => setMenu(true)}>
          <Icon of={MoreHorizontal} size={16} />
        </Tap>
      </div>

      <ViewBar changed={changed} />

      {menu && <WorkspaceMenu sessionId={sessionId} onClose={() => setMenu(false)} />}
      {status && <StatusSheet sessionId={sessionId} onClose={() => setStatus(false)} />}
    </header>
  );
}

/**
 * Chat, Diff, Ship.
 *
 * Three, not the six things a workspace can show. Files, a terminal, a preview
 * and a second agent are in the `⋯` menu, because the two errands somebody
 * opens this on a phone for are answering an agent and shipping what it wrote,
 * and burying the rest is the point rather than a compromise.
 */
function ViewBar({ changed }: { changed: number }) {
  const { screen, show } = useScreen();

  return (
    <div className="flex items-stretch px-1">
      {SCREENS.map((s) => (
        <Tab key={s.id} on={screen === s.id} onClick={() => show(s.id)} label={s.label}>
          {s.id === "changes" && changed > 0 && (
            <span className="rounded-full bg-bone px-1 font-mono text-micro leading-[15px] text-ground">
              {changed > 99 ? "99+" : changed}
            </span>
          )}
        </Tab>
      ))}
    </div>
  );
}

function Tab({
  on,
  onClick,
  label,
  children,
}: {
  on: boolean;
  onClick: () => void;
  label: string;
  children?: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      // Two pixels of bone along the bottom edge, which is the same mark the
      // desk's tab strip puts along the top of the tab you are on.
      className={`relative flex min-h-[44px] flex-1 items-center justify-center gap-1.5 text-ui transition-colors ${
        on
          ? "text-bone after:absolute after:inset-x-3 after:bottom-0 after:h-[2px] after:bg-bone after:content-['']"
          : "text-mute hover:text-dim"
      }`}
    >
      {label}
      {children}
    </button>
  );
}

/** A 44px target around a glyph that is nowhere near 44px. */
function Tap({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className="grid h-11 w-11 shrink-0 place-items-center rounded-md text-dim transition-colors hover:bg-raise hover:text-bone"
    >
      {children}
    </button>
  );
}

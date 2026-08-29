"use client";

/**
 * Reading a task before deciding to work on it.
 *
 * The row has a title and nothing else, so finding out what `#7` actually says
 * meant opening GitHub — which is the tab this page exists to replace.
 *
 * Nothing is fetched here. `Task.body` comes back with the search result and
 * was until now used only to build the first message, so this is a panel over
 * data already in hand.
 */

import { ArrowRight, ChevronLeft, ChevronRight } from "lucide-react";
import { Button, IconButton } from "@/components/ui";
import { useEffect } from "react";
import type { Task } from "@/src/api/generated/model";
import { Modal } from "@/components/Modal";
import { Markdown } from "@/components/Markdown";
import { elapsed, minutesSince } from "@/src/api/view";

export function TaskDialog({
  task,
  at,
  of,
  onMove,
  onClose,
  onStart,
}: {
  task: Task;
  /** Which of the page you are on, one-based, for `2 of 14`. */
  at: number;
  of: number;
  /** Somewhere else in the list, or nothing when there is nowhere to go. */
  onMove: (by: 1 | -1) => void;
  onClose: () => void;
  onStart: () => void;
}) {
  // Triaging a backlog is read, no, next, read, no, next, *that* one — and
  // closing and reopening a dialog fourteen times is what sends people back to
  // GitHub. Arrows move; enter starts; escape is the modal's own.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown" || e.key === "j") onMove(1);
      if (e.key === "ArrowUp" || e.key === "k") onMove(-1);
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onStart();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onMove, onStart]);

  return (
    <Modal onClose={onClose} title={`${task.key} · ${task.repo ?? "task"}`} wide>
      <div className="flex items-center gap-2 pb-3">
        <IconButton
          of={ChevronLeft}
          size="sm"
          label="Previous (↑)"
          onClick={() => onMove(-1)}
          disabled={at <= 1}
        />
        <span className="font-mono text-meta text-mute">
          {at} of {of}
        </span>
        <IconButton
          of={ChevronRight}
          size="sm"
          label="Next (↓)"
          onClick={() => onMove(1)}
          disabled={at >= of}
        />

        <a
          href={task.url}
          target="_blank"
          rel="noreferrer"
          className="ml-auto text-meta text-mute transition-colors hover:text-bone"
        >
          Open on GitHub ↗
        </a>
      </div>

      <h2 className="text-display leading-[1.35] text-bone">{task.title}</h2>

      <div className="mt-2 flex flex-wrap items-center gap-2 border-b border-line pb-3">
        <span
          className={`rounded-sm border px-2 py-0.5 text-meta ${
            task.state === "open" ? "border-sage/40 text-sage" : "border-line text-mute"
          }`}
        >
          {task.state === "open" ? "Open" : "Closed"}
        </span>
        {task.assignees.map((who) => (
          <span key={who.login} className="font-mono text-meta text-dim">
            {who.login}
          </span>
        ))}
        {task.labels.map((label) => (
          <span
            key={label.name}
            className="rounded-sm border px-1.5 py-px text-micro"
            style={
              label.colour
                ? { borderColor: `#${label.colour}66`, color: `#${label.colour}` }
                : undefined
            }
          >
            {label.name}
          </span>
        ))}
        <span className="ml-auto font-mono text-meta text-mute">
          {elapsed(minutesSince(task.updatedAt))} ago
        </span>
      </div>

      {/* Bounded, because an issue with forty comments' worth of description
          would otherwise push the button that starts it off the screen. */}
      <div className="max-h-[46vh] overflow-y-auto py-4">
        {task.body?.trim() ? (
          <Markdown>{task.body}</Markdown>
        ) : (
          <p className="text-ui text-mute">No description.</p>
        )}
      </div>

      <div className="flex items-center justify-between gap-4 border-t border-line pt-3">
        <p className="text-meta text-mute">
          Cuts a worktree and puts this in the composer, unsent.
        </p>
        <Button variant="primary" trailing={ArrowRight} onClick={onStart}>
          Start a worktree
        </Button>
      </div>
    </Modal>
  );
}

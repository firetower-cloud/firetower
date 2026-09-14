"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Icon } from "./Icon";

/**
 * Take that away with you.
 *
 * A transcript is full of things whose only use is somewhere else — a command
 * to paste into a terminal, a block the agent wrote, the contents of a file.
 * Selecting them by hand is the part that goes wrong: a block scrolls sideways,
 * a triple-click stops at a line, and what lands on the clipboard is nearly
 * what was on screen.
 *
 * So the button copies the text the caller already has, rather than whatever
 * the selection happened to catch.
 */
export function CopyButton({
  text,
  label = "Copy",
  className = "",
}: {
  /**
   * What lands on the clipboard. A function for anything only known at the
   * click — the text inside a block that is still being streamed into.
   */
  text: string | (() => string);
  /** Named for a screen reader and, as a title, for everyone else. */
  label?: string;
  className?: string;
}) {
  const [said, setSaid] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | undefined>(undefined);

  // A turn can be scrolled away mid-flash, and the item goes with it.
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    const what = typeof text === "function" ? text() : text;
    if (!what) return;

    setSaid((await write(what)) ? "copied" : "failed");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setSaid("idle"), 1600);
  };

  // The title says it too, not only the glyph. A tick that appears silently is
  // legible only to somebody who was already looking at the button — and a
  // clipboard that refused needs a sentence rather than a shrug.
  const says = said === "copied" ? "Copied" : said === "failed" ? "Couldn't copy" : label;

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={says}
      title={says}
      className={`grid shrink-0 place-items-center rounded-sm p-1 transition-colors ${
        said === "copied" ? "text-sage" : said === "failed" ? "text-brick" : "text-mute"
      } hover:bg-raise hover:text-bone ${className}`}
    >
      <Icon of={said === "copied" ? Check : Copy} size={12} />
    </button>
  );
}

/**
 * A block, with the copy in its top-right corner.
 *
 * Over the content rather than above it, because these sit in a conversation:
 * a row of its own above every block would add a line of furniture to a
 * transcript that is mostly blocks.
 *
 * Always there, quiet, and **opaque**. Hover-only would be invisible on a
 * touchscreen, and a translucent chip lets the line it covers show through it
 * — which on a wide line of code reads as a rendering fault rather than as a
 * button.
 */
export function Copyable({
  text,
  label,
  children,
  className = "",
}: {
  text: string | (() => string);
  label?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`group relative ${className}`}>
      {children}
      <CopyButton
        text={text}
        label={label}
        className="absolute top-1 right-1 z-10 border border-line-soft bg-panel group-hover:border-line"
      />
    </div>
  );
}

/**
 * The clipboard, however this browser has one.
 *
 * `navigator.clipboard` is only there in a secure context, and a self-hosted
 * Firetower is often reached over plain http on a private address — where the
 * modern API is simply `undefined` and the old one still works.
 */
async function write(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Denied permission, or a document that wasn't focused. Try the old way.
  }
  return legacy(text);
}

function legacy(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  // Off-screen rather than hidden: what `display: none` holds cannot be
  // selected, and this works by selecting it.
  area.style.position = "fixed";
  area.style.top = "-1000px";
  area.style.opacity = "0";
  document.body.appendChild(area);

  try {
    area.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

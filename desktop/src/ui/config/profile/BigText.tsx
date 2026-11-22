/**
 * A field for text a person actually writes in — and a door to a bigger room.
 *
 * Instructions is Markdown, it is composed into an agent's prompt, and it is
 * routinely longer than the ten rows a form can spare. In a 392px drawer it
 * is ten rows of forty characters, which is a window onto a document rather
 * than a place to write one. Every such field carries **Open editor**, which
 * is the same text full screen with room to read it.
 *
 * The box below stays live and stays the source of truth — the editor writes
 * through to the same `onChange`, so there is no commit, no draft of a draft,
 * and closing it loses nothing. It is a magnifying glass, not a dialog.
 */
import { useEffect, useRef, useState } from "react";
import { Expand, X } from "lucide-react";
import { Icon, IconButton, Segmented } from "~/components/ui";
import { Markdown } from "~/components/Markdown";

export function BigText({
  value,
  onChange,
  rows = 10,
  placeholder,
  disabled,
  /** What the editor calls itself, so the room says which field you are in. */
  title,
}: {
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  placeholder?: string;
  disabled?: boolean;
  title: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <span className="box mono bigtext">
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={rows}
          placeholder={placeholder}
          disabled={disabled}
          className="scroll-slim"
        />
        {/* Inside the box rather than beside it: it is about this text, and a
            control an inch away from what it acts on is a control you have to
            aim. Bottom right, where a textarea's own resize grip would be —
            that grip is off, because a field that is resizable *and* has a
            full-screen door has two answers to one question. */}
        <button
          type="button"
          onClick={() => setOpen(true)}
          title="Open editor"
          aria-label={`Open the editor for ${title}`}
          className="bigopen"
        >
          <Icon of={Expand} size={12} />
          Open editor
        </button>
      </span>
      {open && (
        <Editor
          title={title}
          value={value}
          onChange={onChange}
          disabled={disabled}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

/** What the room is showing: the text, the rendering, or both. */
type Look = "write" | "split" | "read";

/**
 * The bigger room.
 *
 * **It previews, and the preview is the app's own `Markdown`.** The one the
 * chat renders a turn with and a skill renders its body with — so what you
 * see here is what the heading, the fence and the list will look like
 * everywhere else in Firetower, and there is no second renderer to keep in
 * step. No toolbar: the text is the document, and a bold button is a worse
 * way to type two asterisks.
 *
 * **Split by default where there is room for it**, which is the whole point
 * of a full-screen room — write on the left, watch the structure on the
 * right. Under 1000px there is not room for two measures, so it opens on the
 * text and *Preview* is a press away. The cursor starts in the text either
 * way: you came here to write.
 *
 * Worth saying plainly, because it decides what this is for: **the agent
 * reads the characters, not the rendering.** The preview is for the author —
 * to see that a heading is a heading and a fence is closed — not a promise
 * about what the model receives.
 */
function Editor({
  title,
  value,
  onChange,
  disabled,
  onClose,
}: {
  title: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  onClose: () => void;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const [look, setLook] = useState<Look>(() =>
    typeof window !== "undefined" && window.innerWidth >= 1000 ? "split" : "write",
  );
  useEffect(() => {
    area.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      // Escape closes; nothing is lost, because the field is the same string.
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const [wide, setWide] = useState(
    () => typeof window !== "undefined" && window.innerWidth >= 1000,
  );
  useEffect(() => {
    const measure = () => setWide(window.innerWidth >= 1000);
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  // A window that narrows below two measures drops out of Split rather than
  // leaving a mode on screen its own control no longer offers.
  useEffect(() => {
    if (!wide && look === "split") setLook("write");
  }, [wide, look]);

  const lines = value ? value.split("\n").length : 0;
  const words = value.trim() ? value.trim().split(/\s+/).length : 0;

  return (
    <div className="bigroom" data-look={look} role="dialog" aria-modal aria-label={`${title} — editor`}>
      {/* Head, text and foot share one measure, so the room reads as a
          column rather than a heading at the window's edge above a
          paragraph in the middle of it. */}
      <div className="bighead">
        <span className="in">
        <span className="tx">
          <span className="nm">{title}</span>
          <span className="where">
            Markdown, previewed the way Firetower renders it everywhere else. The agent reads
            the characters, not the rendering.
          </span>
        </span>
        <Segmented
          label="What the room shows"
          value={look}
          onChange={setLook}
          options={[
            ["write", "Write", "The text only"],
            // Two measures need the width for two measures.
            ...(wide ? ([["split", "Split", "Text and preview"]] as const) : []),
            ["read", "Preview", "The rendering only"],
          ]}
        />
        <IconButton of={X} label="Close the editor" onClick={onClose} />
        </span>
      </div>
      <div className="bigbody" data-look={look}>
        {look !== "read" && (
          <textarea
            ref={area}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            spellCheck={false}
            placeholder="# Reviewer&#10;&#10;You review. You do not fix."
            className="scroll-slim"
          />
        )}
        {look !== "write" && (
          <div className="bigread scroll-slim">
            {value.trim() ? (
              <Markdown>{value}</Markdown>
            ) : (
              <p className="nobody">Nothing written yet.</p>
            )}
          </div>
        )}
      </div>
      <div className="bigfoot">
        <span className="in">
        <span className="where">
          {lines} line{lines === 1 ? "" : "s"} · {words} word{words === 1 ? "" : "s"} · written
          into the field as you type
        </span>
        <button onClick={onClose} className="btn primary">
          Done
        </button>
        </span>
      </div>
    </div>
  );
}

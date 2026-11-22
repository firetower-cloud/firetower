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
import { Icon, IconButton } from "~/components/ui";

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

/**
 * The bigger room.
 *
 * **Not a preview, and not a toolbar.** What is being written is a prompt: an
 * agent reads the characters, not a rendering of them, so a rendered pane
 * beside the text would be a picture of something nobody downstream ever
 * sees. What a prompt is short of is width and height, and this is both —
 * a measure wide enough to read a paragraph of, monospaced, on the sheet.
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
  useEffect(() => {
    area.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      // Escape closes; nothing is lost, because the field is the same string.
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const lines = value ? value.split("\n").length : 0;
  const words = value.trim() ? value.trim().split(/\s+/).length : 0;

  return (
    <div className="bigroom" role="dialog" aria-modal aria-label={`${title} — editor`}>
      {/* Head, text and foot share one measure, so the room reads as a
          column rather than a heading at the window's edge above a
          paragraph in the middle of it. */}
      <div className="bighead">
        <span className="in">
        <span className="tx">
          <span className="nm">{title}</span>
          <span className="where">
            Markdown. The agent reads the characters, so there is nothing to preview.
          </span>
        </span>
        <IconButton of={X} label="Close the editor" onClick={onClose} />
        </span>
      </div>
      <div className="bigbody">
        <textarea
          ref={area}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          spellCheck={false}
          placeholder="# Reviewer&#10;&#10;You review. You do not fix."
          className="scroll-slim"
        />
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

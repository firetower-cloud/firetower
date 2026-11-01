/**
 * A "make one" action that offers *how*: by hand, or by asking an agent.
 *
 * The AI choice opens the New page with the composer already started, so the
 * path from "I'd like one of these" to "an agent is writing it" is one click
 * from the very screen that lists them — which is where someone realises they
 * want one. The same shape serves skills and profiles.
 */
import { useState } from "react";
import { ChevronDown, Plus, type LucideIcon } from "lucide-react";
import { Pop } from "~/ui/Pop";

export type CreateChoice = {
  icon: LucideIcon;
  label: string;
  note?: string;
  onPick: () => void;
};

export function CreateMenu({ label, choices }: { label: string; choices: CreateChoice[] }) {
  const [open, setOpen] = useState<HTMLElement | null>(null);
  return (
    <>
      <button
        type="button"
        aria-haspopup="menu"
        onClick={(e) => setOpen(open ? null : e.currentTarget)}
        className="control border border-line bg-raise text-ui text-dim hover:bg-overlay hover:text-bone"
      >
        <Plus className="h-3.5 w-3.5" strokeWidth={2} />
        {label}
        <ChevronDown
          className={`h-3.5 w-3.5 text-mute transition-transform ${open ? "rotate-180" : ""}`}
          strokeWidth={1.75}
        />
      </button>
      {open && (
        <Pop anchor={open} onClose={() => setOpen(null)} width={272}>
          <div role="menu" className="py-1">
            {choices.map((c) => (
              <button
                key={c.label}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(null);
                  c.onPick();
                }}
                className="flex w-full items-start gap-2.5 px-3 py-2 text-left hover:bg-raise"
              >
                <c.icon className="mt-0.5 h-4 w-4 shrink-0 text-dim" strokeWidth={1.75} />
                <span className="min-w-0 flex-1">
                  <span className="block text-ui text-bone">{c.label}</span>
                  {c.note && <span className="block text-micro text-mute">{c.note}</span>}
                </span>
              </button>
            ))}
          </div>
        </Pop>
      )}
    </>
  );
}

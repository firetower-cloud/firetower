/**
 * The editor strip.
 *
 * The conversation is pinned first and cannot be closed — it is what a
 * workspace *is*, and a strip you can empty is a strip you can get lost in.
 * Everything after it is a file, and files behave the way they do in an editor:
 * single click previews in italic and is replaced by the next preview, double
 * click (or an edit) keeps the tab.
 *
 * That preview slot is the whole reason this is worth doing rather than
 * replacing the pane's content: skimming six files while reading a diff should
 * not leave six tabs behind.
 */
import { MessageSquare, X } from "lucide-react";
import { langOf } from "~/syntax";

export type Tab = { id: "chat" } | { id: string; path: string; preview?: boolean };

/** Files get the kind colours the tree already uses. Nine categories, not ninety. */
function tone(path: string): string {
  switch (langOf(path)) {
    case "rust":
      return "text-kind-native";
    case "ts":
      return "text-kind-source";
    case "sql":
      return "text-kind-store";
    case "toml":
      return "text-kind-data";
    case "make":
      return "text-kind-style";
    default:
      return "text-kind-prose";
  }
}

export function TabStrip({
  tabs,
  active,
  onPick,
  onClose,
  onKeep,
}: {
  tabs: Tab[];
  active: string;
  onPick: (id: string) => void;
  onClose: (id: string) => void;
  onKeep: (id: string) => void;
}) {
  return (
    <div className="scroll-slim flex h-10 shrink-0 items-stretch overflow-x-auto border-b border-line bg-panel">
      {tabs.map((tab) => {
        const on = tab.id === active;
        const chat = tab.id === "chat";
        const preview = !chat && "preview" in tab && tab.preview;

        return (
          <div
            key={tab.id}
            onClick={() => onPick(tab.id)}
            onDoubleClick={() => onKeep(tab.id)}
            className={`group/tab relative flex max-w-[15rem] min-w-0 shrink-0 cursor-default items-center gap-2 border-r border-line px-3 transition-colors duration-150 ${
              on ? "bg-ground text-bone" : "text-mute hover:bg-raise/60 hover:text-dim"
            }`}
          >
            {/* Marked along the top edge, where an editor marks it. */}
            {on && <span className="absolute inset-x-0 top-0 h-[2px] bg-bone/70" />}
            {chat ? (
              <MessageSquare className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
            ) : (
              <span className={`shrink-0 text-micro ${on ? tone((tab as { path: string }).path) : ""}`}>
                ●
              </span>
            )}

            <span
              className={`min-w-0 truncate text-ui ${chat ? "" : "font-mono"} ${preview ? "italic" : ""}`}
              title={chat ? "Conversation" : (tab as { path: string }).path}
            >
              {chat ? "Conversation" : (tab as { path: string }).path.split("/").pop()}
            </span>

            {!chat && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.id);
                }}
                className="grid h-5 w-5 shrink-0 place-items-center rounded text-mute opacity-0 transition-opacity group-hover/tab:opacity-100 hover:bg-overlay hover:text-bone"
              >
                <X className="h-3 w-3" strokeWidth={2} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

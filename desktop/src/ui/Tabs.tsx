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
import { Globe, Image, MessageSquare, Shapes, X } from "lucide-react";
import { langOf } from "~/syntax";
import { isImage } from "~/api/text";

export type Tab =
  | { id: "chat" }
  | { id: string; path: string; preview?: boolean; line?: number }
  | { id: string; port: number; path?: string }
  /** An artifact. Named rather than pathed: it is not a file in this workspace. */
  | { id: string; artifactId: string; title: string };

/** Files get the kind colours the tree already uses. Seven categories, not ninety. */
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
  onMenu,
}: {
  tabs: Tab[];
  active: string;
  onPick: (id: string) => void;
  onClose: (id: string) => void;
  onKeep: (id: string) => void;
  onMenu: (e: React.MouseEvent, id: string) => void;
}) {
  return (
    <div className="tabs">
      {tabs.map((tab) => {
        const on = tab.id === active;
        const chat = tab.id === "chat";
        const port = "port" in tab ? tab.port : null;
        const art = "artifactId" in tab ? tab : null;
        const preview = !chat && "preview" in tab && tab.preview;

        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={on}
            data-preview={preview || undefined}
            onClick={() => onPick(tab.id)}
            onDoubleClick={() => onKeep(tab.id)}
            onAuxClick={(e) => e.button === 1 && !chat && onClose(tab.id)}
            onContextMenu={(e) => onMenu(e, tab.id)}
            className={`tab cursor-default select-none ${chat ? "pinned" : ""}`}
          >
            {chat ? (
              <MessageSquare className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
            ) : art ? (
              <Shapes className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
            ) : port !== null ? (
              <Globe className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
            ) : isImage((tab as { path: string }).path) ? (
              /* A picture gets the shape rather than the dot: the dot carries
                 a *language*, and a screenshot is not written in one. */
              <Image className={`h-3.5 w-3.5 shrink-0 ${on ? "text-syn-keyword" : ""}`} strokeWidth={1.75} />
            ) : (
              <span className={`shrink-0 text-micro ${on ? tone((tab as { path: string }).path) : ""}`}>
                ●
              </span>
            )}

            {/* **Not monospace.** A tab carries a *name*, and the mono voice in
                this system is for what a machine said. The file's own text is
                mono; the label above it is not. */}
            <span
              className="nm"
              title={chat ? "Conversation" : art ? art.title : port !== null ? `Port ${port} in this session` : (tab as { path: string }).path}
            >
              {chat ? "Conversation" : art ? art.title : port !== null ? `:${port}` : (tab as { path: string }).path.split("/").pop()}
            </span>

            {!chat && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.id);
                }}
                aria-label="Close this tab"
                className="x"
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

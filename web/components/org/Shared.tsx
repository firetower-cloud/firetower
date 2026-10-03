"use client";

import { Search } from "lucide-react";
import { Icon, Input } from "@/components/ui";

/**
 * What decides which rows are shown, and the one action that adds another.
 *
 * Inside the panel rather than floating above it, and replaced wholesale by
 * `Bulk` when anything is ticked — see the note there. The count sits between
 * the two because it is the thing that changes as you type, and putting it
 * beside the action instead left nothing answering "did the search work".
 */
export function Toolbar({
  find,
  onFind,
  placeholder,
  count,
  action,
}: {
  find: string;
  onFind: (value: string) => void;
  placeholder: string;
  count?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
      {/* Fills what is left, up to a point. Fixed-width, it wrapped the button
          onto its own line inside the narrow pane on the Access screen; left to
          grow, it ran the full width of a table page and looked like the page's
          subject rather than a filter on it. */}
      <span className="relative min-w-0 flex-1 sm:max-w-[16rem]">
        <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-mute">
          <Icon of={Search} size={12} />
        </span>
        <Input value={find} onChange={onFind} placeholder={placeholder} className="w-full pl-7" />
      </span>
      {count && <span className="text-meta text-mute">{count}</span>}
      {action && <span className="ml-auto shrink-0">{action}</span>}
    </div>
  );
}

/**
 * The sentence the server wrote when it refused.
 *
 * Nothing when there is nothing to say, so callers can pass a nullable straight
 * in rather than each writing the same conditional.
 */
export function Trouble({ children }: { children?: React.ReactNode }) {
  if (!children) return null;
  return (
    <p className="border-t border-line bg-brick-tint/40 px-4 py-2.5 text-meta text-brick">
      {children}
    </p>
  );
}

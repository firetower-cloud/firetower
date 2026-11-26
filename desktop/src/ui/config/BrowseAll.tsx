/**
 * The whole catalogue, one screen, as far down as somebody cares to go.
 *
 * **The shelf stopped at thirty and said "search to narrow it".** That is an
 * instruction to already know what you want, in the one place somebody came
 * to find out what exists. Browsing is the feature; the shelf on the library
 * page is the sample.
 *
 * Paged on the server, appended here. The filter and the search go with the
 * request rather than being applied to what came back — a page filtered after
 * it arrives is a search of the first thirty wearing a search box.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Search, Store } from "lucide-react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Blank } from "~/ui/config/bits";
import { listEntries } from "~/api/generated/marketplaces/marketplaces";
import type { Listed } from "~/api/generated/model";

export type Kind = "all" | "skill" | "mcp";

export function BrowseAll({
  kind,
  onKind,
  onBack,
  row,
}: {
  kind: Kind;
  onKind: (k: Kind) => void;
  onBack: () => void;
  /** The library draws its own rows; this only decides which ones. */
  row: (e: Listed) => React.ReactNode;
}) {
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
  /* **Typing is not a request.** One per keystroke is a request per
     keystroke, and the answers come back out of order. */
  useEffect(() => {
    const t = setTimeout(() => setQuery(typed.trim()), 250);
    return () => clearTimeout(t);
  }, [typed]);

  const ask = useInfiniteQuery({
    queryKey: ["catalogue", "all", kind, query],
    initialPageParam: 1,
    queryFn: ({ pageParam }) =>
      listEntries({
        page: pageParam as number,
        q: query || undefined,
        kind: kind === "all" ? undefined : kind === "mcp" ? "mcp" : "skills",
      }),
    getNextPageParam: (last, pages) => (last.more ? pages.length + 1 : undefined),
  });

  const rows = useMemo(
    () => (ask.data?.pages ?? []).flatMap((p) => p.entries),
    [ask.data],
  );
  const total = ask.data?.pages[0]?.total ?? 0;

  /* **The scroll asks for the next page, not a button.** An observer on a
     sentinel under the last row, so reaching the end *is* the request. */
  const edge = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = edge.current;
    if (!node) return;
    const watch = new IntersectionObserver(
      (seen) => {
        if (seen[0]?.isIntersecting && ask.hasNextPage && !ask.isFetchingNextPage) {
          void ask.fetchNextPage();
        }
      },
      // Early enough that the rows are there before the gap is.
      { rootMargin: "400px" },
    );
    watch.observe(node);
    return () => watch.disconnect();
  }, [ask.hasNextPage, ask.isFetchingNextPage, ask.fetchNextPage]);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="out" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" strokeWidth={1.5} />
          Library
        </button>
        <div className="seg2" role="tablist">
          {(["all", "skill", "mcp"] as Kind[]).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={kind === k}
              onClick={() => onKind(k)}
            >
              {k === "all" ? "All" : k === "skill" ? "Skills" : "MCP"}
            </button>
          ))}
        </div>
        <label className="srch ml-auto">
          <Search className="h-4 w-4 text-mute" strokeWidth={1.5} />
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Search everything"
            aria-label="Search the whole catalogue"
            autoFocus
          />
        </label>
      </div>

      <p className="mt-4 text-meta text-dim">
        {ask.isLoading
          ? "Reading your sources…"
          : `${total} ${total === 1 ? "entry" : "entries"}${query ? ` matching “${query}”` : ""}. Taking one copies it, pinned to the commit the list was read at.`}
      </p>

      <div className="offers mt-2">{rows.map((e) => row(e))}</div>

      <div ref={edge} className="h-px" />
      {ask.isFetchingNextPage && (
        <p className="mt-3 text-meta text-mute">Reading more…</p>
      )}
      {!ask.isLoading && rows.length === 0 && (
        <Blank icon={Store} title={query ? "Nothing matches that" : "Nothing on offer"}>
          {query
            ? "Try fewer words, or a different tab."
            : "Add a marketplace on the library page, or refresh one that has not been read."}
        </Blank>
      )}
      {!ask.hasNextPage && rows.length > 0 && (
        <p className="mt-3 text-meta text-mute">That is all of them.</p>
      )}
    </div>
  );
}

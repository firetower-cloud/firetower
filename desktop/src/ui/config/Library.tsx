/**
 * Everything an agent can do past the model, as one list of real things.
 *
 * **It stopped listing bundles.** A bundle is a folder somebody imported, and
 * nobody arrives wanting a folder — they arrive wanting to connect Notion, or
 * to add a skill. So every bundle is flattened into what it carries: one row
 * per skill, one row per server, and the folder survives only as the quiet
 * line saying where a row came from.
 *
 * That is not cosmetic. A server that publishes its own skills has no folder
 * to belong to, and a library built on folders has nowhere to put those rows.
 *
 * **Two controls, two questions.** What it is — all, skills, MCP — filters.
 * Whether you have it — yours, discover — switches. They compose, because
 * "what instructions could I add" is a question somebody really has.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Link2,
  Loader2,
  MoreHorizontal,
  Plus,
  Puzzle,
  RefreshCw,
  Search,
  Store,
  X,
} from "lucide-react";
import { Blank, Dropping, Note, Section } from "~/ui/config/bits";
import { why } from "~/data";
import { useQueryClient } from "@tanstack/react-query";
import { IconButton, MenuItem } from "~/components/ui";
import { Pop } from "~/ui/Pop";
import { useConfirm } from "~/ui/Confirm";
import { AddSkill } from "~/ui/AddSkill";
import { readDrop } from "~/skills";
import { openExternal } from "~/open";
import { useOpened } from "~/ui/opened";
import {
  listLibrary,
  switchItem,
  useListLibrary,
  getListLibraryQueryKey,
} from "~/api/generated/library/library";
import {
  addMarketplace,
  installEntry,
  refreshMarketplace,
  removeMarketplace,
  useListEntries,
  useListMarketplaces,
  getListEntriesQueryKey,
  getListMarketplacesQueryKey,
} from "~/api/generated/marketplaces/marketplaces";
import { connect, disconnect, getConnectorStateQueryKey } from "~/api/generated/connectors/connectors";
import { deleteSkill, getListSkillsQueryKey } from "~/api/generated/skills/skills";
import { probeUrl, addFromUrl } from "~/api/generated/connectors/connectors";
import type { Item, Listed, Market, Skill } from "~/api/generated/model";
import { ServerInside } from "~/ui/config/ServerInside";
import { SkillInside } from "~/ui/config/SkillInside";

/** How many Discover cards are drawn before the search has to do the work. */
const SHELF = 40;

type Kind = "all" | "skill" | "mcp";
type Where = "yours" | "discover";

/** A monogram, from the initial of each hyphenated part. */
export function mono(name: string): string {
  const parts = name.split(/[-_ ]/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2)).toLowerCase();
}

/** A bundle's own mark, or a monogram. Drawn from bytes Firetower holds. */
export function Mark({ logo, name }: { logo?: string | null; name: string }) {
  if (logo)
    return (
      <span className="plg" data-brand>
        <img src={logo} alt="" className="h-[18px] w-[18px] rounded-[4px] object-contain" />
      </span>
    );
  return <span className="plg">{mono(name)}</span>;
}

/** What a catalogue card brings, before anybody has downloaded it. */
function brings(e: Listed): string | null {
  if (!e.counted) return e.category ?? e.author ?? null;
  const bits: string[] = [];
  const say = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (e.hasConnector) bits.push("1 server");
  if (e.nSkills) bits.push(say(e.nSkills, "skill", "skills"));
  if (e.nCommands) bits.push(say(e.nCommands, "command", "commands"));
  if (!bits.length) return null;
  return bits.join(" and ");
}

export function Library({ open: asked = null }: { open?: string | null }) {
  const cache = useQueryClient();
  const [kind, setKind] = useState<Kind>("all");
  /* **Discover first.** What somebody opens this page to do is add
     something; what they already have is one press away and is not a
     question they came here with. */
  const [where, setWhere] = useState<Where>("discover");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [trouble, setTrouble] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [over, setOver] = useState(false);
  const seed = useRef<ReturnType<typeof readDrop> | null>(null);
  const [open, setOpen] = useOpened(asked);

  /* **The browser is somewhere else.** Authorizing happens in a tab outside
     this app and nothing in that tab can tell us it finished, so the list
     watches for the answer instead of waiting to be told. Two triggers,
     because either alone leaves a case: polling catches somebody who
     finishes in the background, and refetching on focus catches the ordinary
     path of approving and switching straight back. The poll stops as soon as
     something connects and gives up after five minutes rather than asking
     for ever.

     The page this one replaced did exactly this, per row. Listing components
     took the row's own state away and nothing replaced it, so a server
     stayed on "Connect" until the page was reopened. */
  const [awaiting, setAwaiting] = useState(false);
  const lib = useListLibrary({
    query: {
      select: (r) => r ?? [],
      refetchOnWindowFocus: true,
      refetchInterval: awaiting ? 2000 : false,
    },
  });
  const connectedCount = (lib.data ?? []).filter((i) => i.connected === true).length;
  useEffect(() => {
    if (!awaiting) return;
    const stop = setTimeout(() => setAwaiting(false), 5 * 60 * 1000);
    return () => clearTimeout(stop);
  }, [awaiting, connectedCount]);
  const catalogue = useListEntries(undefined, { query: { select: (r) => r ?? [] } });

  const refresh = async () => {
    await Promise.all([
      cache.invalidateQueries({ queryKey: getListLibraryQueryKey() }),
      cache.invalidateQueries({ queryKey: getListSkillsQueryKey() }),
      cache.invalidateQueries({ queryKey: getListEntriesQueryKey() }),
    ]);
  };

  const matches = (text: string) => {
    const t = query.trim().toLowerCase();
    return !t || text.toLowerCase().includes(t);
  };

  const yours = useMemo(
    () =>
      (lib.data ?? [])
        .filter((i) => kind === "all" || (kind === "mcp" ? i.kind === "server" : i.kind === "skill"))
        .filter((i) => matches(`${i.name} ${i.description} ${i.from ?? ""}`)),
    [lib.data, kind, query],
  );

  const offered = useMemo(
    () =>
      (catalogue.data ?? [])
        .filter((e) =>
          kind === "all" ? true : kind === "mcp" ? e.hasConnector : e.nSkills > 0 || e.nCommands > 0,
        )
        .filter((e) => matches(`${e.name} ${e.description}`)),
    [catalogue.data, kind, query],
  );
  const shown = offered.slice(0, SHELF);
  const more = offered.length - shown.length;

  /**
   * Adding a server is already asking for its tools.
   *
   * **So the browser opens by itself.** Making somebody find a second button
   * to say what they just said is asking the same question twice. An attempt
   * made on your behalf that the other end refuses stays quiet — some servers
   * register no clients, and a modal nobody pressed anything for is worse
   * than a Connect button that is still there.
   */
  const offerToConnect = async (skillId: string) => {
    try {
      const opened = await connect(skillId);
      await openExternal(opened.authorizeUrl);
      setAwaiting(true);
    } catch {
      /* The row keeps its Connect button, and pressing it says why. */
    }
  };

  const install = async (e: Listed) => {
    setBusy(e.slug);
    setTrouble(null);
    try {
      const made = await installEntry(e.marketplaceId, e.slug);
      await refresh();
      if (made.hasConnector) await offerToConnect(made.id);
    } catch (err) {
      setTrouble(why(err));
    } finally {
      setBusy(null);
    }
  };

  const opened = open ? (lib.data ?? []).find((i) => i.id === open) : undefined;
  if (opened)
    return opened.kind === "server" ? (
      <ServerInside of={opened} onBack={() => setOpen(null)} onGone={refresh} />
    ) : (
      <SkillInside of={opened} onBack={() => setOpen(null)} />
    );

  if (adding)
    return (
      <AddSkill
        seed={seed.current}
        onClose={() => setAdding(false)}
        onDone={() => {
          setAdding(false);
          seed.current = null;
          void refresh();
        }}
      />
    );

  const surface = {
    onDragOver: (e: React.DragEvent) => {
      if (![...(e.dataTransfer?.types ?? [])].includes("Files")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setOver(true);
    },
    onDragLeave: () => setOver(false),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setOver(false);
      seed.current = readDrop(e.dataTransfer);
      setAdding(true);
    },
  };

  return (
    <div {...surface} className="relative">
      {over && (
        <Dropping says="A skill, a folder of them, or a .zip of either. The source says which is which, and nothing is written until you have looked at what was found." />
      )}
      <Section
        title="Skills &amp; MCP"
        action={
          <div className="flex items-center gap-2">
            <button type="button" className="out" onClick={() => setPasting((p) => !p)}>
              <Link2 className="h-4 w-4" strokeWidth={1.5} />
              Connect a server
            </button>
            <button type="button" className="btn primary" onClick={() => setAdding(true)}>
              <Plus className="h-4 w-4" strokeWidth={1.75} />
              Add a skill
            </button>
          </div>
        }
        controls={
          <div className="flex w-full items-center gap-3">
            <div className="seg2" role="tablist">
              {(["all", "skill", "mcp"] as Kind[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  aria-selected={kind === k}
                  onClick={() => setKind(k)}
                >
                  {k === "all" ? "All" : k === "skill" ? "Skills" : "MCP"}
                </button>
              ))}
            </div>
            <span className="h-5 w-px bg-line" />
            <div className="seg2" role="tablist">
              {(["yours", "discover"] as Where[]).map((w) => (
                <button
                  key={w}
                  type="button"
                  role="tab"
                  aria-selected={where === w}
                  onClick={() => setWhere(w)}
                >
                  {w === "yours" ? "Yours" : "Discover"}
                </button>
              ))}
            </div>
            <label className="srch ml-auto">
              <Search className="h-4 w-4 text-mute" strokeWidth={1.5} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search"
                aria-label="Search the library"
              />
            </label>
          </div>
        }
        error={lib.error ? why(lib.error) : null}
        settling={lib.isLoading}
      >
        {trouble && <Note icon={Puzzle}>{trouble}</Note>}

        {pasting && (
          <PasteAddress
            onClose={() => setPasting(false)}
            onDone={() => {
              setPasting(false);
              void refresh();
            }}
          />
        )}

        {where === "yours" ? (
          <>
            <p className="mt-4 text-meta text-dim">
              {yours.length} — the ticked ones load into a plain agent of yours. A profile
              decides for itself.
            </p>
            <div className="mt-2">
              {yours.map((i) => (
                <Thing
                  key={i.id}
                  of={i}
                  busy={busy === i.id}
                  onOpen={() => setOpen(i.id)}
                  onConnecting={() => setAwaiting(true)}
                  onBusy={setBusy}
                  onChanged={refresh}
                  onTrouble={setTrouble}
                />
              ))}
            </div>
            {yours.length === 0 && !lib.isLoading && (
              <Blank icon={Puzzle} title={query ? "Nothing matches that" : "Nothing here yet"}>
                {query
                  ? "Clear the search, or look in Discover."
                  : "Connect a server, add a skill, or take one from Discover."}
              </Blank>
            )}
          </>
        ) : (
          <>
            <p className="mt-4 text-meta text-dim">
              {offered.length} from your sources. Something you already have says so rather
              than hiding — adding one takes a copy pinned to the commit the list was read at.
            </p>
            <div className="pgrid mt-2">
              {shown.map((e) => (
                <div key={`${e.marketplaceId}/${e.slug}`} className="pcard" data-had={e.installed || undefined}>
                  <span className="top">
                    <Mark logo={e.logo} name={e.name} />
                    <span className="nm">
                      <b>{e.name}</b>
                      {e.author && <s>by {e.author}</s>}
                    </span>
                  </span>
                  <span className="desc">{e.description}</span>
                  <span className="foot">
                    <span className="chip3">{brings(e) ?? "—"}</span>
                    {e.installed ? (
                      <span className="flex items-center gap-1.5 text-meta text-sage">
                        <Check className="h-3.5 w-3.5" strokeWidth={2} />
                        Added
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="add"
                        disabled={busy === e.slug}
                        onClick={() => install(e)}
                      >
                        {busy === e.slug ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
                        ) : (
                          <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
                        )}
                        Add
                      </button>
                    )}
                  </span>
                </div>
              ))}
            </div>
            {more > 0 && (
              <p className="mt-3 text-meta text-dim">{more} more. Search to narrow it.</p>
            )}
            {offered.length === 0 && (
              <Blank icon={Store} title="Nothing on offer">
                Add a marketplace below, or refresh one that has not been read.
              </Blank>
            )}
            <Sources />
          </>
        )}
      </Section>
    </div>
  );
}

/**
 * One thing in the library.
 *
 * **One button, then one menu.** Whatever is blocking gets the button —
 * Connect, and nothing else ever — and the rest lives behind the ⋯, in the
 * same place on every line.
 */
function Thing({
  of,
  busy,
  onOpen,
  onConnecting,
  onBusy,
  onChanged,
  onTrouble,
}: {
  of: Item;
  busy: boolean;
  onOpen: () => void;
  /** An authorization is outstanding, so the list should start watching. */
  onConnecting: () => void;
  onBusy: (id: string | null) => void;
  onChanged: () => Promise<void>;
  onTrouble: (why: string | null) => void;
}) {
  const confirm = useConfirm();
  const cache = useQueryClient();
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [going, setGoing] = useState(false);

  const flip = async () => {
    onBusy(of.id);
    try {
      await switchItem({ id: of.id, on: !of.on });
      await onChanged();
    } catch (e) {
      onTrouble(why(e));
    } finally {
      onBusy(null);
    }
  };

  const join = async () => {
    setGoing(true);
    try {
      const opened = await connect(of.skillId);
      await openExternal(opened.authorizeUrl);
      onConnecting();
    } catch (e) {
      onTrouble(why(e));
    } finally {
      setGoing(false);
    }
  };

  const remove = async () => {
    setGoing(true);
    try {
      await deleteSkill(of.skillId);
      await onChanged();
    } catch (e) {
      onTrouble(why(e));
    } finally {
      setGoing(false);
    }
  };

  return (
    <div className="r">
      <span className="g">
        <Mark logo={of.logo} name={of.name} />
      </span>
      <button type="button" className="tx text-left" onClick={onOpen}>
        <b>{of.name}</b>
        <s>{of.description || "no description of its own"}</s>
      </button>

      {of.from && (
        <span className="shrink-0 text-meta text-mute">
          from <span className="text-dim">{of.from}</span>
        </span>
      )}

      {of.kind === "server" && of.url && (
        <span className="shrink-0 font-mono text-meta text-mute">
          {of.url.replace(/^https?:\/\//, "").split("/")[0]}
        </span>
      )}

      {of.kind === "server" &&
        (of.connected === true ? (
          <span className="shrink-0 text-sage" title={`Connected to ${of.server}.`}>
            <Link2 className="h-4 w-4" strokeWidth={1.75} />
          </span>
        ) : of.connected === false ? (
          <button type="button" className="on" disabled={going} onClick={join}>
            {going ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
            ) : (
              <Link2 className="h-3.5 w-3.5" strokeWidth={1.75} />
            )}
            Connect
          </button>
        ) : null)}

      {/* **No switch where there is no choice.** A drawn control that the
          server refuses is worse than no control: it says a decision is
          yours and then takes it back. `firetower-artifacts` is what the
          artifact feature is built on — turning it off would not announce
          itself, it would make agents quietly stop publishing. */}
      {of.required ? (
        <span className="shrink-0 text-meta text-mute" title={of.whyRequired ?? undefined}>
          always on
        </span>
      ) : (
        <button
          type="button"
          role="switch"
          aria-checked={of.on}
          aria-label={`${of.name} on by default`}
          title={
            of.on
              ? "A plain agent of yours opens with this. Anybody can untick it before they send."
              : "Not loaded unless somebody picks it when starting."
          }
          className="tog shrink-0"
          disabled={busy}
          onClick={flip}
        >
          <i />
        </button>
      )}

      <div>
        <IconButton
          of={MoreHorizontal}
          onClick={(e) => setMenu(menu ? null : e.currentTarget)}
          label={`More for ${of.name}`}
          className="hov"
        />
        {menu && (
          <Pop anchor={menu} onClose={() => setMenu(null)}>
            <div className="w-60 py-1">
              <MenuItem
                onClick={() => {
                  setMenu(null);
                  onOpen();
                }}
              >
                What is in it
              </MenuItem>
              {of.connected === true && (
                <MenuItem
                  disabled={going}
                  onClick={() => {
                    setMenu(null);
                    void confirm({
                      title: `Disconnect ${of.name}?`,
                      body: "Your credential is forgotten. It stays in the library, and anybody else here keeps theirs. Sessions already running keep the token they were given.",
                      action: "Disconnect",
                      tone: "danger",
                    }).then((ok) => {
                      if (!ok) return;
                      void disconnect(of.skillId).then(async () => {
                        await cache.invalidateQueries({
                          queryKey: getConnectorStateQueryKey(of.skillId),
                        });
                        await onChanged();
                      });
                    });
                  }}
                >
                  Disconnect
                </MenuItem>
              )}
              <MenuItem
                tone="danger"
                disabled={going || of.builtin}
                onClick={() => {
                  setMenu(null);
                  void confirm({
                    title: `Remove ${of.name}?`,
                    /* **The one moment the bundle is named.** Removing acts on
                       what it arrived in, so anything else in that folder goes
                       with it — and a silent loss is the failure this sentence
                       exists to prevent. */
                    body: of.from
                      ? `It arrived with ${of.from}, so everything else that came in with ${of.from} goes too. Sessions already running keep what they were given, and it can be added again.`
                      : "It goes from the library. Sessions already running keep what they were given, and it can be added again.",
                    action: "Remove",
                    tone: "danger",
                  }).then((ok) => {
                    if (ok) void remove();
                  });
                }}
              >
                {of.builtin ? "Ships with Firetower" : of.from ? `Remove ${of.from}` : "Remove"}
              </MenuItem>
            </div>
          </Pop>
        )}
      </div>
    </div>
  );
}

/** How long ago, in the one unit worth reading. */
function when(at?: string | null): string {
  if (!at) return "never read";
  const mins = Math.round((Date.now() - new Date(at).getTime()) / 60000);
  if (mins < 1) return "read just now";
  if (mins < 60) return `read ${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `read ${hours}h ago`;
  return `read ${Math.round(hours / 24)}d ago`;
}

/**
 * Where these come from.
 *
 * **A source is a listing, never an installer.** Refreshing rewrites what is
 * on offer and touches nothing anybody has a copy of — which is why adding
 * somebody else's repository is a smaller act than it sounds.
 */
function Sources() {
  const feed = useListMarketplaces({ query: { select: (r) => r ?? [] } });
  const cache = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [bad, setBad] = useState<string | null>(null);

  const reload = async () => {
    await cache.invalidateQueries({ queryKey: getListMarketplacesQueryKey() });
    await cache.invalidateQueries({ queryKey: getListEntriesQueryKey() });
  };

  const run = async (what: string, go: () => Promise<unknown>) => {
    setBusy(what);
    setBad(null);
    try {
      await go();
      await reload();
    } catch (e) {
      setBad(why(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="mt-8 border-t border-line pt-5">
      <h3 className="text-ui text-dim">Where these come from</h3>
      <p className="mt-1 max-w-[74ch] text-meta text-dim">
        A repository of skills and servers. Firetower reads the list; it never installs
        anything on its own, and nothing is fetched until you ask.
      </p>
      {bad && <Note icon={Store}>{bad}</Note>}
      <div className="mt-2">
        {feed.data?.map((m: Market) => (
          <div key={m.id} className="r">
            <span className="plg">
              <Store className="h-[15px] w-[15px]" strokeWidth={1.5} />
            </span>
            <span className="tx">
              <b>{m.name}</b>
              <s>
                {m.error
                  ? m.error
                  : `${m.url.replace("https://github.com/", "")} on ${m.gitRef}, ${when(m.fetchedAt)}`}
              </s>
            </span>
            <span className="chip3">
              {m.entries} {m.entries === 1 ? "entry" : "entries"}
            </span>
            <button
              type="button"
              className="out"
              disabled={busy === m.id}
              onClick={() => run(m.id, () => refreshMarketplace(m.id))}
            >
              {busy === m.id ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.5} />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" strokeWidth={1.5} />
              )}
              Refresh
            </button>
            <IconButton
              of={X}
              label={`Remove ${m.name}`}
              onClick={() => run(m.id, () => removeMarketplace(m.id))}
            />
          </div>
        ))}

        {adding ? (
          <div className="mt-2 rounded-xl bg-raise p-3">
            <input
              autoFocus
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) =>
                e.key === "Enter" &&
                run("new", async () => {
                  await addMarketplace({ url: url.trim(), gitRef: null });
                  setUrl("");
                  setAdding(false);
                })
              }
              placeholder="https://github.com/owner/repo"
              aria-label="A marketplace repository"
              className="w-full bg-transparent font-mono text-ui text-bone outline-none placeholder:text-mute"
            />
            <p className="mt-2 max-w-[70ch] text-meta text-dim">
              A GitHub repository holding <span className="font-mono">marketplace.json</span>.
              Anthropic&rsquo;s own catalogue works here, which is the point: a folder written
              for Claude Code runs on every engine Firetower starts.
            </p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                className="btn primary"
                disabled={busy === "new"}
                onClick={() =>
                  run("new", async () => {
                    await addMarketplace({ url: url.trim(), gitRef: null });
                    setUrl("");
                    setAdding(false);
                  })
                }
              >
                {busy === "new" && <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.5} />}
                Read it
              </button>
              <button type="button" className="btn quiet" onClick={() => setAdding(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="out mt-2" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" strokeWidth={1.5} />
            Add a marketplace
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * An address, turned into a server.
 *
 * **A bare MCP URL is an entry path, not a concept.** Firetower asks the
 * server what it is and how it wants to be authorized, writes the manifest
 * itself, and lands it in the library. Nobody is asked to author a wrapper.
 */
function PasteAddress({
  onClose,
  onDone,
}: {
  onClose: () => void;
  /** The thing that was made, so the caller can offer to connect it. */
  onDone: (made?: Skill) => void | Promise<void>;
}) {
  const [url, setUrl] = useState("");
  const [found, setFound] = useState<Awaited<ReturnType<typeof probeUrl>> | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [bad, setBad] = useState<string | null>(null);

  const look = async () => {
    setBusy(true);
    setBad(null);
    try {
      const got = await probeUrl({ url: url.trim() });
      setFound(got);
      setName(got.name);
    } catch (e) {
      setBad(why(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 rounded-xl bg-raise p-4">
      {!found ? (
        <>
          <input
            autoFocus
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && look()}
            placeholder="https://mcp.example.com/mcp"
            aria-label="An MCP server address"
            className="w-full bg-transparent font-mono text-ui text-bone outline-none placeholder:text-mute"
          />
          <p className="mt-2 max-w-[70ch] text-meta text-dim">
            The address of an <b>MCP server</b>. Firetower asks it what it is and how it wants
            authorizing, then writes the rest itself.
          </p>
          {bad && <p className="mt-2 text-meta text-brick">{bad}</p>}
          <div className="mt-3 flex gap-2">
            <button type="button" className="btn primary" disabled={busy || !url.trim()} onClick={look}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.5} />}
              Ask it
            </button>
            <button type="button" className="btn quiet" onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center gap-3">
            <Mark logo={found.logo} name={found.name} />
            <div className="min-w-0 flex-1">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                aria-label="What to call it"
                className="w-full bg-transparent text-ui text-bone outline-none"
              />
              <p className="truncate font-mono text-meta text-mute">{found.host}</p>
            </div>
            <span className="chip3">
              {found.auth === "oauth"
                ? "you will authorize it"
                : found.auth === "borrow-git"
                  ? "uses your git credential"
                  : "no authorization"}
            </span>
          </div>
          {bad && <p className="mt-2 text-meta text-brick">{bad}</p>}
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setBad(null);
                try {
                  const made = await addFromUrl({ url: url.trim(), name });
                  await onDone(made);
                } catch (e) {
                  setBad(why(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.5} />}
              Add it
            </button>
            <button type="button" className="btn quiet" onClick={() => setFound(null)}>
              Back
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export { listLibrary };

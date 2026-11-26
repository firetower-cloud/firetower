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
  ArrowLeft,
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
import { Take } from "~/ui/config/Take";
import { AddMenu } from "~/ui/config/AddMenu";
import { BrowseAll } from "~/ui/config/BrowseAll";
import { SetUpClientModal, type NeedsClient } from "~/ui/config/SetUpClient";
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
import { OfferInside } from "~/ui/config/OfferInside";

/** How many Discover cards are drawn before the search has to do the work. */
const SHELF = 40;

type Kind = "all" | "skill" | "mcp";
type Where = "installed" | "discover";

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
        <img src={logo} alt="" className="h-[18px] w-[18px] rounded-xs object-contain" />
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
  /* **Typing is not a request.** One per keystroke is a request per
     keystroke, and the answers come back out of order. The shelf and the
     browse list both read the settled value. */
  const [settled, setSettled] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setSettled(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);
  const [busy, setBusy] = useState<string | null>(null);
  /* **Rows added in this sitting stay where they were.** Pressing a button
     and having the thing you pressed jump to another part of the page is how
     somebody loses their place and presses again — so the move to "Already
     added" waits until the list is next looked at fresh. */
  const [stayPut, setStayPut] = useState<Set<string>>(new Set());

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
  /* **It said the poll stops as soon as something connects. It did not.**
     The effect only restarted the five-minute timer when the count moved, so
     a server that authorized straight away kept the two-second poll running
     and kept its row on "Waiting…" for the rest of the five minutes. The
     count when the wait began is the baseline; one more than that is the
     answer arriving. */
  const countWhenAsked = useRef(0);
  useEffect(() => {
    if (awaiting) countWhenAsked.current = connectedCount;
    // Only when the wait begins: re-reading it every render would move the
    // baseline up with the answer and never fire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [awaiting]);
  useEffect(() => {
    if (!awaiting) return;
    if (connectedCount > countWhenAsked.current) {
      setAwaiting(false);
      return;
    }
    const stop = setTimeout(() => setAwaiting(false), 5 * 60 * 1000);
    return () => clearTimeout(stop);
  }, [awaiting, connectedCount]);
  /* **Narrowed by the server, not by us.** The browser used to be handed
     every row and filter them; with a page that is a search of page one. So
     the query box and the segmented control travel with the request, and the
     two shelves are two questions rather than one list cut in half. */
  const asking = {
    q: settled || undefined,
    kind: kind === "all" ? undefined : kind === "mcp" ? "mcp" : "skills",
  };
  const held = useListEntries(
    { ...asking, installed: true },
    { query: { select: (r) => r?.entries ?? [] } },
  );
  const catalogue = useListEntries({ ...asking, installed: false, page: 1 }, {});

  const refresh = async () => {
    await Promise.all([
      cache.invalidateQueries({ queryKey: getListLibraryQueryKey() }),
      cache.invalidateQueries({ queryKey: getListSkillsQueryKey() }),
      cache.invalidateQueries({ queryKey: getListEntriesQueryKey() }),
    ]);
  };

  /* The library is small and already here, so this one stays local. */
  const matches = (text: string) => {
    const t = query.trim().toLowerCase();
    return !t || text.toLowerCase().includes(t);
  };

  const yours = useMemo(
    () =>
      (lib.data ?? [])
        .filter((i) => kind === "all" || (kind === "mcp" ? i.kind === "server" : i.kind === "skill"))
        .filter((i) => matches(`${i.displayName} ${i.name} ${i.description} ${i.from ?? ""}`)),
    [lib.data, kind, query],
  );

  const offered = catalogue.data?.entries ?? [];
  const waiting = catalogue.data?.total ?? 0;
  /* **A card knows what it became.** An entry and the thing it installed to
     are the same object seen twice, and the catalogue row alone cannot say
     whether you have authorized it — so the two are matched by name, which
     is what the installer used. Without this a card said "Added" and stopped
     there, with the one thing left to do a tab away. */
  const mine = useMemo(() => {
    const by = new Map<string, Item>();
    for (const i of lib.data ?? []) if (!by.has(i.name)) by.set(i.name, i);
    return by;
  }, [lib.data]);

  /* A row pressed in this sitting is still on the shelf it was pressed on,
     because it has not been looked at fresh yet. */
  const have = [
    ...(held.data ?? []),
    ...offered.filter((e) => e.installed && stayPut.has(e.slug)),
  ];
  const rest = offered.filter((e) => !e.installed || stayPut.has(e.slug));
  const [all, setAll] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  /** The catalogue row a preview is open on, handed over when it was opened. */
  const [peek, setPeek] = useState<Listed | undefined>();
  /* **The form opens where Connect was pressed.** A server that will not
     hand out a client used to answer Connect with a sentence telling
     somebody to open the details and press a second button — three screens
     to reach a form we already knew they needed. Nineteen entries hit that,
     including every Google one. */
  const [setting, setSetting] = useState<NeedsClient | null>(null);
  const INSTALLED = 4;
  const shown = rest.slice(0, SHELF);
  const more = Math.max(0, waiting - shown.length);

  /**
   * Adding a server is already asking for its tools.
   *
   * **So the browser opens by itself.** Making somebody find a second button
   * to say what they just said is asking the same question twice. An attempt
   * made on your behalf that the other end refuses stays quiet — some servers
   * register no clients, and a modal nobody pressed anything for is worse
   * than a Connect button that is still there.
   */
  /**
   * What the library knows about a server, for the form.
   *
   * **Asked for, not read off the render.** The row that needs this most is
   * one installed a moment ago by the same press, and `lib.data` in this
   * closure is whatever it held before that install — so the console link
   * and the readable name would both be missing in exactly the case the form
   * exists for.
   */
  const needing = async (id: string) => {
    const rows = await listLibrary().catch(() => null);
    const i = (rows ?? lib.data ?? []).find((x) => x.skillId === id && x.kind === "server");
    if (!i) return null;
    const of: NeedsClient = {
      skillId: id,
      displayName: i.displayName,
      setup: i.setup,
    };
    return { of, needsClientId: i.needsClientId === true };
  };

  /**
   * Open the browser, or the form, depending on which one this needs.
   *
   * **Asked before it is attempted.** Installing records what the server
   * said about authorizing, so by the time this runs we already know whether
   * it hands out clients — and a request made in order to be refused is a
   * spinner, a failure and a modal where the modal alone was the answer.
   *
   * One case cannot be known in advance and keeps the catch: a server that
   * advertises a registration endpoint and then refuses it. Figma does
   * exactly that, and there is no way to find out but to try.
   */
  const offerToConnect = async (made: { id: string; hasConnector?: boolean }) => {
    const known = await needing(made.id);
    if (known?.needsClientId) {
      setSetting(known.of);
      return;
    }
    try {
      const opened = await connect(made.id);
      await openExternal(opened.authorizeUrl);
      setAwaiting(true);
    } catch (e) {
      const says = why(e);
      // The code, not the sentence: prose is what the person reads, and a
      // reworded sentence must not quietly stop opening the form.
      const wants = (e as { code?: string })?.code === "ConnectorNeedsClient";
      const of = wants ? (known?.of ?? (await needing(made.id))?.of) : null;
      if (of) setSetting(of);
      else setTrouble(says);
    }
  };

  /**
   * One press, whatever it takes.
   *
   * **Add and Connect were two steps for one intention.** Nobody wants a
   * copy of Notion; they want an agent that can read Notion — so a row that
   * brings a server installs it *and* opens the browser, and the label says
   * which of those is the point. Only a skills-only entry is an Add, because
   * there is nothing after it.
   */
  const take = async (e: Listed) => {
    setBusy(e.slug);
    setTrouble(null);
    setStayPut((k) => new Set(k).add(e.slug));
    try {
      /* An entry already installed is connected straight away; one that is
         not is installed first. Either way the id is the library's. */
      const held = e.installed
        ? (lib.data ?? []).find((i) => i.name === e.name && i.kind === "server")?.skillId
        : undefined;
      const install = held
        ? Promise.resolve(held)
        : installEntry(e.marketplaceId, e.slug).then((made) => made.id);

      /* **The entry already said this one needs an application.** `setup` is
         only there because the server hands out no clients, so the form can
         go up now rather than after a second and a half of installing — a
         wait whose whole purpose is to learn what the row is holding. */
      if (e.setup?.length && e.hasConnector) {
        setSetting({
          skillId: held,
          ready: install,
          displayName: e.displayName,
          setup: e.setup,
        });
        setBusy(null);
        await install;
        await refresh();
        return;
      }

      const id = await install;
      await refresh();
      if (id && e.hasConnector) await offerToConnect({ id, hasConnector: true });
    } catch (err) {
      setTrouble(why(err));
    } finally {
      setBusy(null);
    }
  };

  /* An entry nobody has installed opens too, on a preview pulled at the
     pinned commit — the handle is the catalogue's rather than the library's,
     which is what tells the two apart. */
  const peeked = open?.startsWith("offer:") ? peek : undefined;
  if (peeked)
    return (
      <OfferInside
        of={peeked}
        busy={busy === peeked.slug}
        onBack={() => setOpen(null)}
        onAdd={() => void take(peeked).then(() => setOpen(null))}
      />
    );

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
          <AddMenu onUpload={() => setAdding(true)} onConnect={() => setPasting(true)} />
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
                  onClick={() => {
                    setKind(k);
                    setStayPut(new Set());
                  }}
                >
                  {k === "all" ? "All" : k === "skill" ? "Skills" : "MCP"}
                </button>
              ))}
            </div>
            <span className="h-5 w-px bg-line" />
            {/* **One header, not two.** Browsing everything used to open a
                panel carrying its own filter and its own search box, inside
                a page that already had both — so the screen showed two of
                each. The page owns them; this slot is the only thing that
                differs, because "installed or discover" is not a question
                somebody is asking while looking at all of it. */}
            {browsing ? (
              <button type="button" className="out" onClick={() => setBrowsing(false)}>
                <ArrowLeft className="h-4 w-4" strokeWidth={1.5} />
                Library
              </button>
            ) : (
            <div className="seg2" role="tablist">
              {(["installed", "discover"] as Where[]).map((w) => (
                <button
                  key={w}
                  type="button"
                  role="tab"
                  aria-selected={where === w}
                  onClick={() => {
                    setWhere(w);
                    setStayPut(new Set());
                  }}
                >
                  {/* **Not "Yours".** Nothing in this list is: two ship with
                      the product and the rest are installed for the whole
                      organisation, so a colleague's install turns up here
                      too. It is what this Firetower has, which is a fact
                      about the installation and not about a person. */}
                  {w === "installed" ? "Installed" : "Discover"}
                </button>
              ))}
            </div>
            )}
            <label className="srch ml-auto">
              <Search className="h-4 w-4 text-mute" strokeWidth={1.5} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={browsing ? "Search everything" : "Search"}
                aria-label={browsing ? "Search the whole catalogue" : "Search the library"}
              />
            </label>
          </div>
        }
        error={lib.error ? why(lib.error) : null}
        settling={lib.isLoading}
      >
        {trouble && <Note icon={Puzzle}>{trouble}</Note>}

        {setting && (
          <SetUpClientModal
            of={setting}
            onCancel={() => setSetting(null)}
            onDone={async (id) => {
              setSetting(null);
              await refresh();
              /* Straight into authorizing: supplying the application was
                 only ever the thing standing in front of connecting. */
              await offerToConnect({ id, hasConnector: true });
            }}
          />
        )}

        {pasting && (
          <PasteAddress
            onClose={() => setPasting(false)}
            onDone={() => {
              setPasting(false);
              void refresh();
            }}
          />
        )}

        {browsing ? (
          <BrowseAll
            kind={kind}
            query={settled}
            row={(e) => (
              <Offer
                key={`${e.marketplaceId}/${e.slug}`}
                of={e}
                item={mine.get(e.name)}
                busy={busy === e.slug}
                waiting={awaiting && stayPut.has(e.slug)}
                onOpen={(id, e) => {
                        setPeek(e);
                        setOpen(id);
                      }}
                onSetUp={(i) =>
                  setSetting({
                    skillId: i.skillId,
                    displayName: i.displayName,
                    setup: i.setup,
                  })
                }
                onConnect={offerToConnect}
                onAdd={take}
              />
            )}
          />
        ) : where === "installed" ? (
          <>
            {/* **No switch here any more.** Having something and using it in
                a particular run are different questions, and only the second
                one has an answer that changes often. The composer asks it, a
                press away from the prompt, where somebody can see what the
                agent is about to be handed. */}
            <p className="mt-4 text-meta text-dim">
              {yours.length} on this Firetower — what ships with it, and what anybody here
              has installed. All of it is offered when you start an agent; the composer is
              where you choose what that one gets.
            </p>
            <div className="mt-2">
              {yours.map((i) => (
                <Thing
                  key={i.id}
                  of={i}
                  onOpen={() => setOpen(i.id)}
                  onSetUp={() =>
                    setSetting({
                      skillId: i.skillId,
                      displayName: i.displayName,
                      setup: i.setup,
                    })
                  }
                  onConnecting={() => setAwaiting(true)}
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
            {/* **What you have, first and small.** Browsing a catalogue with
                no sense of what is already yours is how somebody installs the
                same thing twice — and the one thing a just-added server still
                needs is a press, which belonged here rather than a tab away. */}
            {have.length > 0 && (
              <>
                <div className="mt-4 flex items-baseline gap-3">
                  <h3 className="text-ui text-dim">Already added</h3>
                  <span className="text-meta text-mute">{have.length}</span>
                  {have.length > INSTALLED && (
                    <button
                      type="button"
                      className="ml-auto text-meta text-dim hover:text-bone"
                      onClick={() => setAll((v) => !v)}
                    >
                      {all ? "Show fewer" : `Show all ${have.length}`}
                    </button>
                  )}
                </div>
                <div className="offers mt-2">
                  {(all ? have : have.slice(0, INSTALLED)).map((e) => (
                    <Offer
                      key={`${e.marketplaceId}/${e.slug}`}
                      of={e}
                      item={mine.get(e.name)}
                      busy={busy === e.slug}
                      waiting={awaiting && stayPut.has(e.slug)}
                      onOpen={(id, e) => {
                        setPeek(e);
                        setOpen(id);
                      }}
                      onSetUp={(i) =>
                        setSetting({
                          skillId: i.skillId,
                          displayName: i.displayName,
                          setup: i.setup,
                        })
                      }
                      onConnect={offerToConnect}
                      onAdd={take}
                    />
                  ))}
                </div>
                <div className="mt-6 border-t border-line" />
              </>
            )}

            <p className="mt-4 text-meta text-dim">
              {rest.length} more from your sources. Adding one takes a copy pinned to the
              commit the list was read at.
            </p>
            <div className="offers mt-2">
              {shown.map((e) => (
                <Offer
                  key={`${e.marketplaceId}/${e.slug}`}
                  of={e}
                  item={mine.get(e.name)}
                  busy={busy === e.slug}
                  waiting={awaiting && stayPut.has(e.slug)}
                  onOpen={(id, e) => {
                        setPeek(e);
                        setOpen(id);
                      }}
                  onSetUp={(i) =>
                    setSetting({
                      skillId: i.skillId,
                      displayName: i.displayName,
                      setup: i.setup,
                    })
                  }
                  onConnect={offerToConnect}
                  onAdd={take}
                />
              ))}
            </div>
            {/* **The way through, not an instruction to already know.**
                "Search to narrow it" told somebody to name what they wanted
                in the one place they came to find out what there is. */}
            {more > 0 && (
              <button
                type="button"
                className="out mt-3"
                onClick={() => setBrowsing(true)}
              >
                Show all {waiting}
              </button>
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
  onOpen,
  onSetUp,
  onConnecting,
  onChanged,
  onTrouble,
}: {
  of: Item;
  onOpen: () => void;
  /** Supply the OAuth application this server will not hand out. */
  onSetUp: () => void;
  /** An authorization is outstanding, so the list should start watching. */
  onConnecting: () => void;
  onChanged: () => Promise<void>;
  onTrouble: (why: string | null) => void;
}) {
  const confirm = useConfirm();
  const cache = useQueryClient();
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [going, setGoing] = useState(false);

  const join = async () => {
    // Known before it is attempted — the row is already holding the answer.
    // `Take` only shows Connect when this is false, so reaching here with it
    // true means the row was drawn before the library caught up.
    if (of.needsClientId) {
      onSetUp();
      return;
    }
    setGoing(true);
    try {
      const opened = await connect(of.skillId);
      await openExternal(opened.authorizeUrl);
      onConnecting();
    } catch (e) {
      // A server that advertises registration and then refuses it cannot be
      // known in advance, so this is the one that still finds out by trying.
      if ((e as { code?: string })?.code === "ConnectorNeedsClient") onSetUp();
      else onTrouble(why(e));
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
        <Mark logo={of.logo} name={of.displayName} />
      </span>
      <button type="button" className="tx text-left" onClick={onOpen}>
        <b>{of.displayName}</b>
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

      {/* **The same control as the catalogue row and the detail screen.**
          This used to be a third variant: a sentence for a server needing an
          application, a bare icon once connected, a differently-shaped
          button otherwise. The sentence also still said Firetower could not
          hold a client id, which stopped being true when the form landed. */}
      {of.kind === "server" && (
        <Take
          of={{
            hasConnector: true,
            installed: true,
            connected: of.connected,
            needsClientId: of.needsClientId,
          }}
          busy={going}
          onPress={join}
          // Not the detail screen: the form is the thing being asked for.
          onOpen={onSetUp}
        />
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

/**
 * One catalogue row.
 *
 * **A row, not a card.** Six cards filled a screen that now holds twelve
 * rows: the padding, the border and the separate footer line were spending
 * height on nothing, and a catalogue is a thing you scan rather than read.
 * Two columns of hairline-separated rows is what every catalogue worth
 * copying does, and it is the shape the eye already knows.
 *
 * **It carries its own state.** An entry and the thing it installed to are
 * one object seen twice, matched by the name the installer used — so a row
 * that has been added can offer the press it is still waiting for, instead
 * of saying "Added" and sending somebody to another tab to finish.
 */
function Offer({
  of,
  item,
  busy,
  waiting,
  onOpen,
  onSetUp,
  onConnect,
  onAdd,
}: {
  of: Listed;
  /** What it became, once it is installed. */
  item?: Item;
  busy: boolean;
  onOpen: (id: string, of: Listed) => void;
  /** Supply the OAuth application this server will not hand out. */
  onSetUp: (item: Item) => void;
  onConnect: (made: { id: string; hasConnector?: boolean }) => Promise<void>;
  onAdd: (e: Listed) => Promise<void>;
  /** An authorization this row started is outstanding. */
  waiting?: boolean;
}) {
  /* **The entry travels with the handle.** Looking it back up by id only
     worked while the whole catalogue was in memory; with pages, opening a row
     from page three found nothing. */
  const open = () => onOpen(item ? item.id : `offer:${of.marketplaceId}/${of.slug}`, of);
  return (
    <div className="offer">
      <span className="g">
        <Mark logo={of.logo} name={of.displayName} />
      </span>
      {/* **Every row opens.** One already installed shows what it became;
          one nobody has downloaded shows a preview pulled from its
          repository — which is the only way to read a stranger's
          instructions before agreeing to run them. */}
      <button type="button" className="tx text-left" onClick={open}>
        <b>{of.displayName}</b>
        <s>{of.description}</s>
        <u>{[brings(of), of.author && `by ${of.author}`].filter(Boolean).join(", ")}</u>
      </button>

      {/* **The same control as every other screen.** This row said Connect
          and the detail screen for the same entry said Add, in a different
          shape — two names for one action, a click apart. `Take` owns the
          words now, and both call it. */}
      <Take
        of={{
          hasConnector: of.hasConnector,
          installed: of.installed,
          connected: item?.connected,
          needsClientId: item?.needsClientId,
        }}
        busy={busy}
        waiting={waiting}
        onPress={() => void onAdd(of)}
        // "Set it up" wants the form, not the page the form lives on.
        onOpen={item ? () => onSetUp(item) : open}
      />
    </div>
  );
}

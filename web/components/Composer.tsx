"use client";

import { useCallback, useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { useListRepos, useRepoBranches } from "@/src/api/generated/repos/repos";
import { useListAgents } from "@/src/api/generated/agents/agents";
import {
  useListHosts,
  useConnectHost,
  getListHostsQueryKey,
} from "@/src/api/generated/hosts/hosts";
import type { Agent, AgentView, Host } from "@/src/api/generated/model";
import {
  useCreateSession,
  getListSessionsQueryKey,
} from "@/src/api/generated/sessions/sessions";
import { useQueryClient } from "@tanstack/react-query";

/**
 * Whether this agent could run on this particular host.
 *
 * Authentication is per host, not global: a subscription lives in the agent's
 * own config on the machine it was signed in on, so one host being logged in
 * says nothing about another. Only a token we hold travels.
 *
 * Getting this wrong offered a container that had no credentials at all,
 * because a laptop elsewhere happened to be signed in.
 */
function canRun(agent: AgentView, hostId: string) {
  const here = agent.hosts.find((h) => h.hostId === hostId);
  if (!here?.installed) return false;
  if (!agent.needsCredential) return true;

  // Either this host is signed in itself, or we have a token to give it.
  return here.loggedIn === true || agent.credentialSet;
}

/**
 * What the chip shows for an agent, given the machine that's chosen.
 *
 * Marked rather than hidden: disappearing from a dropdown looks like the thing
 * doesn't exist, and leaves nowhere to learn what is missing.
 */
function agentLabel(agent: AgentView, runsHere: boolean) {
  if (runsHere) return agent.label;
  return `${agent.label} · unavailable here`;
}

export function Composer() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  /**
   * The repositories this session will check out, in order.
   *
   * A list rather than one, because work is often two of them — an API and the
   * client that calls it — and two sessions that cannot see each other is not
   * an answer to that. Empty is a bare agent: a workspace with nothing checked
   * out, which is still a real choice.
   */
  const [checkouts, setCheckouts] = useState<{ id: string; slug: string; base?: string }[]>([]);
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState("");
  const [agent, setAgent] = useState<Agent | "">("");
  const [branch, setBranch] = useState<string>("");
  const [hostId, setHostId] = useState<string>("");
  const ta = useRef<HTMLTextAreaElement>(null);
  const router = useRouter();
  const queryClient = useQueryClient();

  const { data: repos = [] } = useListRepos();

  // The first one, for everything that wants a single name: the caption when
  // the composer is closed, the branch suggestion.
  const repo = checkouts[0] ? repos.find((r) => r.id === checkouts[0].id) : undefined;

  // What every chosen repository brings, not just the first. Two of them bring
  // two sets, and the count is the thing worth saying before you start.
  const variables = [
    ...new Set(
      checkouts.flatMap((c) => repos.find((r) => r.id === c.id)?.env ?? []),
    ),
  ];
  const unpicked = repos.filter(
    (r) =>
      !checkouts.some((p) => p.id === r.id) &&
      r.slug.toLowerCase().includes(search.trim().toLowerCase()),
  );

  const { data: agents = [] } = useListAgents();
  const { data: allHosts = [] } = useListHosts();

  // Where first, then what. The machine decides which agents are available —
  // an agent is software installed on a particular host, so asking the other
  // way round means the machine you picked can vanish from its own list.
  //
  // A host that isn't answering stays on the list. Removing it says "you have
  // no compute", which is a different thing from "we can't see your compute
  // this second" and sends you off to add a machine you already own.
  const hosts = allHosts.filter((h) => !h.drained);
  const host =
    hosts.find((h) => h.id === hostId) ??
    hosts.find((h) => h.state === "Online") ??
    hosts[0];

  // Reconnecting counts: the launch waits for it, and it is usually seconds.
  //
  // But only for a machine that has worked before. A host with nothing
  // installed on it reconnects forever — the supervisor keeps trying, and
  // there is nothing there to answer — so without `workerVersion` it would sit
  // in this list looking launchable and fail every time. Having ever reported a
  // version is the difference between "briefly away" and "never worked".
  const usable = (h?: Host) =>
    !!h && (h.state === "Online" || (h.reconnecting && !!h.workerVersion));

  /**
   * What a host is called in the picker.
   *
   * A machine with nothing on it stays in the list rather than disappearing —
   * you added it, and it not being there would be its own puzzle — but it says
   * why it cannot be checkouts. Used for the value and the matcher as well as the
   * options, because a label that differs between the three selects nothing.
   */
  const label = (h: Host) => (usable(h) ? picked(h) : `${picked(h)} · no worker`);

  /** Whether this agent could run on the host that's currently chosen. */
  const runsHere = (a: AgentView) => (host ? canRun(a, host.id) : false);

  // Every agent, in the order they'd be useful, each labelled with what the
  // chosen machine can actually do with it.
  const choices = [...agents].sort(
    (a, b) => Number(runsHere(b)) - Number(runsHere(a)),
  );
  const chosenAgent = (agent ||
    choices.find(runsHere)?.kind ||
    choices[0]?.kind) as Agent | undefined;
  const chosen = choices.find((c) => c.kind === chosenAgent);

  const create = useCreateSession({
    mutation: {
      onSuccess: (session) => {
        queryClient.invalidateQueries({ queryKey: getListSessionsQueryKey() });
        router.push(`/sessions/${session.id}`);
      },
    },
  });

  useEffect(() => {
    if (open) ta.current?.focus();
  }, [open]);

  /* Launching opens the session — you land on the workspace being built. */
  const launch = () => {
    if (!text.trim() || !chosenAgent || create.isPending) return;
    create.mutate({
      data: {
        // Every repository, each with its own base. The branch is the
        // session's and is the same in all of them, which is what makes a
        // change across two of them reviewable.
        repos: checkouts.map((p) => ({ repoId: p.id, base: p.base })),
        prompt: text.trim(),
        agent: chosenAgent,
        branch: checkouts.length ? branch.trim() || undefined : undefined,
        hostId: host?.id,
      },
    });
  };

  return (
    <div
      className={`panel overflow-hidden transition-colors ${
        open ? "border-line bg-raise" : "hover:border-[#33302c]"
      }`}
    >
      <div className="flex items-start gap-3 px-4 py-3">
        <textarea
          ref={ta}
          rows={open ? 3 : 1}
          value={text}
          placeholder="What should we work on?"
          onFocus={() => setOpen(true)}
          // Clicking counts too. Escape closes it without moving the cursor, so
          // without this the next click fires no focus event and the row of
          // controls has no way back.
          onClick={() => setOpen(true)}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) launch();
            if (e.key === "Escape") setOpen(false);
          }}
          className="flex-1 resize-none bg-transparent text-[14px] leading-6 text-bone placeholder:text-mute focus:outline-none"
        />
        {!open && (
          <span className="mt-0.5 font-mono text-[11px] text-mute">
            {checkouts.length === 0
              ? "No repository"
              : checkouts.length === 1
                ? checkouts[0].slug
                : `${checkouts[0].slug} +${checkouts.length - 1}`}
          </span>
        )}
      </div>

      {open && (
        <div className="border-t border-line px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            {checkouts.map((c) => (
              <RepoChip
                key={c.id}
                repoId={c.id}
                slug={c.slug}
                base={c.base}
                onBase={(base) =>
                  setCheckouts((held) =>
                    held.map((h) => (h.id === c.id ? { ...h, base } : h)),
                  )
                }
                onRemove={() => setCheckouts((held) => held.filter((h) => h.id !== c.id))}
              />
            ))}

            {/* One more, and the list of what is left. Search because a fleet
                has more repositories than a menu can hold. */}
            <Picker
              label={`+ ${checkouts.length === 0 ? "repository" : "another"}`}
              open={adding}
              onOpen={() => {
                setAdding(!adding);
                setSearch("");
              }}
              onClose={() => setAdding(false)}
            >
              <input
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => e.key === "Escape" && setAdding(false)}
                placeholder="Search repositories"
                className="mb-1 w-full rounded-[6px] bg-ground px-2.5 py-1.5 text-[12.5px] text-bone placeholder:text-mute focus:outline-none"
              />
              <ul className="max-h-[240px] overflow-y-auto">
                {unpicked.length === 0 && (
                  <li className="px-2.5 py-2 text-[12px] text-mute">
                    {repos.length === 0 ? "Nothing connected yet." : "All of them are in."}
                  </li>
                )}
                {unpicked.map((r) => (
                  <li key={r.id}>
                    <button
                      onClick={() => {
                        setCheckouts((held) => [...held, { id: r.id, slug: r.slug }]);
                        setAdding(false);
                      }}
                      className="w-full rounded-[6px] px-2.5 py-1.5 text-left font-mono text-[12px] text-text transition-colors hover:bg-raise"
                    >
                      {r.slug}
                    </button>
                  </li>
                ))}
              </ul>
            </Picker>

            {repo && (
            <label className="flex items-center gap-1.5 rounded-[5px] border border-line bg-panel py-1 pr-2 pl-2 text-[12px] text-dim transition-colors focus-within:border-ember/40 hover:border-[#3a3631]">
              <span className="text-mute">⎇</span>
              <input
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                placeholder={suggestion(text)}
                spellCheck={false}
                className="w-[190px] bg-transparent font-mono text-[11.5px] text-bone placeholder:text-mute focus:outline-none"
              />
            </label>
            )}

            {/* Every machine that's up. Nothing here is filtered by which
                agent you picked — that would hide the thing you just added. */}
            <Chip
              glyph="host"
              value={host ? label(host) : ""}
              onChange={(name) => setHostId(hosts.find((h) => label(h) === name)?.id ?? "")}
              options={hosts.length ? hosts.map(label) : ["nowhere to run"]}
            />

            <Chip
              glyph="agent"
              value={chosen ? agentLabel(chosen, runsHere(chosen)) : "no agent"}
              onChange={(name) =>
                setAgent(
                  choices.find((c) => agentLabel(c, runsHere(c)) === name)?.kind ?? "",
                )
              }
              options={choices.map((c) => agentLabel(c, runsHere(c)))}
            />

            {/* Said before you start rather than discovered in the terminal:
                this repository hands the agent things you configured weeks ago
                and have every right to have forgotten. */}
            {variables.length > 0 && (
              <span className="font-mono text-[11px] text-mute" title={variables.join(" · ")}>
                + {variables.length} {variables.length === 1 ? "variable" : "variables"}
              </span>
            )}

            <div className="ml-auto flex items-center">
              <button
                onClick={launch}
                disabled={
                  !text.trim() ||
                  !usable(host) ||
                  !chosen ||
                  !runsHere(chosen) ||
                  create.isPending
                }
                title="Launch (⌘↵)"
                className="flex items-center gap-2 rounded-[5px] bg-ember px-3.5 py-1.5 text-[12.5px] font-semibold text-[#1a0c04] transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:bg-line disabled:text-mute"
              >
                {create.isPending
                  ? host?.state === "Online"
                    ? "Opening…"
                    : `Waiting for ${where(host)}…`
                  : "Launch"}
                {/* On the button, as everywhere else: a shortcut floating
                    beside a control is a caption for whatever it lands next
                    to. */}
                {!create.isPending && (
                  <span aria-hidden className="font-mono text-[12px] opacity-60">
                    ⌘↵
                  </span>
                )}
              </button>
            </div>
          </div>

          {create.isError && (
            <p className="mt-2.5 border-t border-line pt-2.5 font-mono text-[11.5px] text-brick">
              {(create.error as { code?: string; message?: string }).code === "NoCapacity"
                ? "No host is available to take this."
                : (create.error as { message?: string }).message ?? "Couldn't launch."}
            </p>
          )}

          {host && host.state !== "Online" && <Absent host={host} />}

          <p className="mt-2.5 border-t border-line pt-2.5 text-[11.5px] text-mute">
            {hosts.length === 0
              ? "You have no compute. Add a machine first."
              : !chosen
                ? "No agent to run. Install one on a host."
                : !runsHere(chosen)
                  ? `${where(host)} can't run ${chosen.label} — ${
                      chosen.hosts.find((h) => h.hostId === host?.id)?.installed
                        ? "it has no credentials there. Give it a token on the Agents screen; this machine being signed in doesn't cover other hosts."
                        : "it isn't installed there."
                    }`
                  : repo
                    ? "Opens the session so you can watch it start. The workspace stays until you end the session."
                    : "A workspace with nothing checked out — the agent starts where you put it and clones nothing."}
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * What the branch would be called if you leave it alone.
 *
 * Shown as a placeholder rather than filled in, so the field stays yours to
 * type in and the fallback is visible without being in the way.
 */
function suggestion(prompt: string) {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 5)
    .join("-");
  return slug ? `agent/${slug}` : "branch name";
}

/** What to show for the chosen agent, before the list has loaded. */

/**
 * What to call a host in the picker.
 *
 * "this machine" rather than `localhost`, because where a session runs is a
 * meaningfully different answer and a hostname doesn't say it.
 */
function where(host?: Host) {
  if (!host) return "nowhere to run";
  return host.compute.type === "Local" ? "this machine" : host.name;
}

/** The same name, plus what we can see of the machine. */
function picked(host?: Host) {
  if (!host) return "nowhere to run";
  if (host.state === "Online") return where(host);
  return `${where(host)} — ${host.reconnecting ? "reconnecting" : "unreachable"}`;
}

/**
 * A machine you own that we can't see.
 *
 * Says which of the two it is, because they need different things from you: one
 * resolves itself in seconds, the other is waiting on you to fix something.
 */
function Absent({ host }: { host: Host }) {
  const queryClient = useQueryClient();
  const connect = useConnectHost();

  const retry = () =>
    connect.mutate(
      { id: host.id },
      {
        onSuccess: () =>
          queryClient.invalidateQueries({ queryKey: getListHostsQueryKey() }),
      },
    );

  return (
    <div className="mt-2.5 flex items-start gap-3 border-t border-line pt-2.5">
      <p className="flex-1 text-[11.5px] leading-[1.5] text-mute">
        {host.reconnecting ? (
          <>
            {where(host)} isn&apos;t answering — trying it again.
            {host.diagnosis && ` ${host.diagnosis.summary}`} Launching waits up to
            30 seconds for it.
          </>
        ) : (
          <>
            {where(host)} isn&apos;t answering.
            {host.diagnosis && ` ${host.diagnosis.summary}`}
          </>
        )}
      </p>
      <button
        onClick={retry}
        disabled={connect.isPending}
        className="shrink-0 rounded-[5px] border border-line px-2 py-1 text-[11.5px] text-dim transition-colors hover:border-[#3a3631] hover:text-text disabled:text-mute"
      >
        {connect.isPending ? "Trying…" : "Try now"}
      </button>
    </div>
  );
}



const GLYPHS: Record<string, React.ReactNode> = {
  repo: "▣",
  branch: "⑂",
  agent: "◈",
  host: "⌂",
};

/**
 * A menu that opens outside the box it belongs to.
 *
 * The composer clips its own corners, which is right — and it means anything
 * absolutely positioned inside it is cut off at the edge. The chips beside this
 * one get away with a native `<select>`, which the browser draws over
 * everything; this one needs a search field, so it is drawn into the document
 * and positioned against its own button.
 *
 * Above the button when there is room, which there usually is: the composer
 * sits at the bottom of the page.
 */
function Picker({
  label,
  open,
  onOpen,
  onClose,
  children,
}: {
  label: string;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top?: number; bottom?: number } | null>(null);

  // Measured when it opens and whenever the page moves under it, never during
  // a render — the position comes from the DOM, so it is read where the DOM is
  // already settled.
  const place = useCallback(() => {
    const box = trigger.current?.getBoundingClientRect();
    if (!box) return;
    setAt(
      box.top > 280
        ? { left: box.left, bottom: window.innerHeight - box.top + 6 }
        : { left: box.left, top: box.bottom + 6 },
    );
  }, []);

  useEffect(() => {
    if (!open) return;

    const away = (e: MouseEvent) => {
      const on = e.target as Node;
      if (!trigger.current?.contains(on) && !menu.current?.contains(on)) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();

    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", key);
    // Anchored to the button, so it has to follow it.
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", key);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, onClose, place]);

  return (
    <>
      <button
        ref={trigger}
        onClick={() => {
          place();
          onOpen();
        }}
        className="flex items-center gap-1.5 rounded-[5px] border border-dashed border-line bg-panel px-2 py-1 text-[12px] text-mute transition-colors hover:border-ember/40 hover:text-text"
      >
        {label}
      </button>

      {open &&
        at &&
        createPortal(
          <div
            ref={menu}
            style={{ left: at.left, top: at.top, bottom: at.bottom }}
            className="fixed z-50 w-[300px] rounded-[10px] border border-line bg-panel p-1.5 shadow-[0_12px_36px_-14px_rgba(0,0,0,0.85)]"
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * One repository in the list, with the branch it starts from.
 *
 * Its own component because the branches come from the remote, one request per
 * repository — and a session holds any number of them. Reading main from one
 * and a release branch from another is a real thing to want, so each carries
 * its own.
 */
function RepoChip({
  repoId,
  slug,
  base,
  onBase,
  onRemove,
}: {
  repoId: string;
  slug: string;
  base?: string;
  onBase: (base: string) => void;
  onRemove: () => void;
}) {
  // It reaches the remote, so only once this repository is actually in.
  const { data: info } = useRepoBranches(repoId, { query: { enabled: true } });
  const branches = info?.branches ?? [];

  // What we know, never a guess. A repository connected while nothing could
  // read it has no trunk yet, and sending `main` on its behalf is how you
  // branch from the wrong place in a repository that calls it something else —
  // the host doing the clone works it out instead.
  const showing = base ?? info?.defaultBranch ?? "its default branch";

  return (
    <span className="flex items-center rounded-[5px] border border-line bg-panel text-[12px] text-dim">
      <span className="flex items-center gap-1.5 py-1 pl-2">
        <span className="text-mute">▣</span>
        <span className="max-w-[170px] truncate font-mono text-[11.5px] text-bone">{slug}</span>
      </span>

      <label className="group relative flex items-center gap-1 border-l border-line py-1 pr-5 pl-2">
        <span className="text-mute">⑂</span>
        <span className="max-w-[110px] truncate font-mono text-[11.5px]">{showing}</span>
        <span className="pointer-events-none absolute right-1.5 text-[9px] text-mute">▾</span>
        <select
          value={showing}
          onChange={(e) => onBase(e.target.value)}
          aria-label={`Branch to start ${slug} from`}
          className="absolute inset-0 cursor-pointer opacity-0"
        >
          {(branches.length ? branches : [showing]).map((b) => (
            <option key={b}>{b}</option>
          ))}
        </select>
      </label>

      <button
        onClick={onRemove}
        aria-label={`Remove ${slug}`}
        className="border-l border-line px-1.5 py-1 text-[12px] text-mute transition-colors hover:text-brick"
      >
        ×
      </button>
    </span>
  );
}

function Chip({
  glyph,
  value,
  options,
  onChange,
}: {
  glyph: string;
  value: string;
  options: string[];
  onChange?: (v: string) => void;
}) {
  return (
    <label className="group relative flex items-center gap-1.5 rounded-[5px] border border-line bg-panel py-1 pr-6 pl-2 text-[12px] text-dim transition-colors hover:border-[#3a3631] hover:text-text">
      <span className="text-mute">{GLYPHS[glyph]}</span>
      <span className="max-w-[150px] truncate">{value}</span>
      <span className="pointer-events-none absolute right-2 text-[9px] text-mute">▾</span>
      <select
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        {options.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    </label>
  );
}

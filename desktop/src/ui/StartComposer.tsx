/**
 * Starting work, docked at the foot of the Dashboard.
 *
 * It was a page of its own at `/new`, with a "Good afternoon" over it and the
 * workspace list somewhere else entirely — so starting something meant leaving
 * the screen that told you whether you should. It is one screen now: this
 * frames the Dashboard and carries the composer, and `/new` lands here.
 *
 * **The shelf is the two things a workspace *is*** — the repository and the
 * machine — on their own plane above the input, because on this screen those
 * choices are *unmade* and making them is the act of starting work. The footer
 * carries who does it and how. Inside a workspace all of that is settled, so
 * the composer there has no shelf; that is `Composer.tsx` and it stays as it
 * is.
 *
 * **It takes the whole screen's drops.** The surface is this wrapper rather
 * than the scroller inside it — the overlay is positioned against it, and an
 * overlay inside a scroller slides off the top as soon as the page is
 * scrolled. The Dashboard's own content is `children`, which is what lets one
 * drop handler cover both.
 *
 * What you type **is** the first message, delivered once the workspace is set
 * up. Leave it empty and the agent comes up idle. The data hooks, the fields
 * and the `NewSession` payload are shared with the rest of the client; only
 * the shape on screen is this one's own.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  ChevronDown,
  CircleAlert,
  ExternalLink,
  FolderGit2,
  GitBranch,
  Paperclip,
  Plus,
  Server,
  ServerOff,
  UserRound,
  Users,
  X,
} from "lucide-react";
import { Icon } from "~/components/ui";
import { AgentMark } from "~/components/AgentMark";
import { RunPicker } from "~/ui/RunPicker";
import { Mic } from "~/ui/voice/Mic";
import { VoiceDialog } from "~/ui/voice/Dialogs";
import { useVoice } from "~/ui/voice/useVoice";
import { useAgentControls } from "~/api/generated/agents/agents";
import { Pop } from "~/ui/Pop";
import { Head, Menu, Opt, Sift, looselyMatches } from "~/ui/menus";
import { Readout, isReady } from "~/components/HostReadiness";
import { useHostReadiness } from "~/api/generated/hosts/hosts";
import { useListRoles } from "~/api/generated/roles/roles";
import { useListAgentTeams } from "~/api/generated/agent-teams/agent-teams";
import { useCreateSession } from "~/api/generated/sessions/sessions";
import { machineLabel, machines } from "~/api/environments";
import { canRun, NoMachine, resolve, type Where } from "~/components/WhereItRuns";
import { usable } from "~/api/accounts";
import { useAccounts, useAgents, useHosts, useRepos, useSkills } from "~/data";
import { ConnectAccount } from "~/ui/config/ConnectAccount";
import { navigate, usePathname } from "~/shims/next-navigation";
import { leaveDraft } from "~/workspace/draft";
import { post, whichServer } from "~/workspace/outbox";
import { base64, chipFor, Chips, Dropping, sift, type Chip } from "~/ui/attach";
import { folderRefusals, useFileDrop } from "~/ui/drop";
import { openExternal } from "~/open";
import { isMac } from "~/platform";
import { dropSeed, seedWaiting, type Seed } from "~/start";
import type { Agent, AgentTeam, Control, ControlKind, Role } from "~/api/generated/model";

type Checkout = { id: string; slug: string };

/**
 * The skills a new workspace starts with: the always-on ones, plus the ones
 * this person has set as a default in a repository it checks out.
 *
 * **`defaultIn` is slugs.** The server builds it as `array_agg(r.slug)` over
 * `skill_defaults` joined to `repos` — a row stores `repo_id` and the read
 * translates it — so what arrives is `acme/web` and never `r_web`. Both
 * callers matched it against `checkout.id`, which can never be equal to a
 * slug, so a skill marked "use by default in this repository" was dropped
 * from every workspace started here and nothing said so.
 *
 * Exported for its own test, and shared with the schedule sheet rather than
 * written twice: the two copies of this line were wrong in the same way. It
 * hands back the skills and leaves the caller to take the ids, which is what
 * both of them already did.
 */
export function defaultSkills<S extends { alwaysOn: boolean; defaultIn: string[] }>(
  skills: S[],
  checkouts: { slug: string }[],
): S[] {
  return skills.filter(
    (s) => s.alwaysOn || s.defaultIn.some((r) => checkouts.some((c) => c.slug === r)),
  );
}

/* The engine and account last started with, kept on this machine so the New
   page opens on them. Model, effort and permissions already come back through
   the agent's remembered controls, so only these two need a home here. */
const LAST_AGENT = "ft:new:agent";
const LAST_ACCOUNT = "ft:new:account";
const remember = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode, or no storage — not worth failing a start over. */
  }
};
const recall = (key: string) => {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
};

/* The whole of it, uncapped. The length cap belongs to `fewWords`, which is
   the only thing that knows where a word ends — it used to be a `.slice(0, 48)`
   here, and the two of them in sequence left the mid-word cut this was written
   to remove. */
const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * A few words of a title, cut on a word boundary.
 *
 * *Quota meter goes amber too early on the free plan* becomes
 * `quota-meter-goes-amber` — enough to recognise in `git branch` and not a
 * sentence. Cut between words, never mid-word, because a branch ending in
 * `…-ea` reads as a typo.
 *
 * And never left ending on an article or a preposition. *Quota meter rounds
 * the wrong way* cut at twenty-four is `quota-meter-rounds-the`, which reads
 * as a sentence that was interrupted; dropping a trailing word of three
 * letters or fewer gives `quota-meter-rounds`, which reads as a name.
 */
const fewWords = (s: string, within = 24) => {
  const full = slug(s);
  if (full.length <= within) return full;
  const cut = full.slice(0, within + 1);
  const at = cut.lastIndexOf("-");
  const kept = at > 0 ? cut.slice(0, at) : full.slice(0, within);
  const parts = kept.split("-");
  return parts.length > 1 && parts[parts.length - 1].length <= 3
    ? parts.slice(0, -1).join("-")
    : kept;
};

/**
 * The branch a workspace will be cut on — shown in the composer's footer
 * before you commit to it, rather than discovered afterwards.
 *
 * **With a task key, the key leads**: `agent/nw-4120-quota-meter-goes-amber`.
 * It is stable, short, greppable and survives the title being edited; a few
 * words of the title follow because a branch list of bare keys tells you
 * nothing about what any of them was.
 *
 * Without one, this is what it has always been — the first line, slugged.
 * A task with a URL and no key falls back to exactly that.
 */
export function branchFor(first: string, taskKey?: string | null): string {
  const key = taskKey ? slug(taskKey) : "";
  /* **The no-key branch keeps its length and gains the word boundary.**
     `slug` caps at 48 with a bare `slice`, so a long title has always cut
     mid-word — `…-on-the-free-pla`. That is the defect `fewWords` exists to
     prevent, and it was live on every branch this build cuts. Same rule, one
     function, and nothing gets shorter than it was. */
  const stem = key ? [key, fewWords(first)].filter(Boolean).join("-") : fewWords(first, 48);
  return `agent/${stem || "work"}`;
}

/**
 * What the composer opens with, from whatever the launch already knew.
 *
 * **A task prefills it.** This was the premise that needed correcting: the
 * composer was never prefilled — `useState(seed?.prompt ?? "")`, and a task's
 * Start sets `title`, `repo`, `issue`, `taskKey` and `taskUrl` and never
 * `prompt`. The title and URL did reach the agent, as a draft handed over
 * *after* the session started, so nobody saw them before pressing send and
 * the page you landed on was blank — indistinguishable from *Start did
 * nothing*.
 *
 * The URL is on its own line under the title because that is what the agent
 * needs to go and read the thing, and because it is the one part nobody wants
 * to retype.
 */
/**
 * What the page says when you arrived carrying a task.
 *
 * The greeting is stateless by design, and arriving from a task makes the
 * loudest thing on the screen contradict the arrival. This names the thing —
 * and **deliberately does not repeat the title**, which is three inches below
 * it in the composer.
 *
 * A URL with no key is the state no fixture has: a tracker that does not give
 * its issues short names. *Start this task* is as specific as the launch can
 * honestly be, and it is still about the thing you came here for.
 */
export function taskHeadline(seed?: Seed): string {
  return seed?.taskKey ? `Start ${seed.taskKey}` : "Start this task";
}

export function seeded(seed?: Seed): string {
  if (seed?.prompt) return seed.prompt;
  if (!seed?.taskKey && !seed?.taskUrl) return "";
  return [seed.title, seed.taskUrl].filter(Boolean).join("\n");
}

export function StartComposer({
  mid,
  above,
  bare,
  children,
}: {
  /**
   * The composer sits **in the middle of the page** rather than docked to its
   * foot — the home's arrangement, where a greeting is above it and what is
   * waiting is below. Same composer either way; only the frame moves.
   */
  mid?: boolean;
  /** What goes above it. On the home, the greeting. */
  above?: React.ReactNode;
  /** Nothing waiting and nothing published: first run, centred. */
  bare?: boolean;
  children: React.ReactNode;
}) {
  /* **Read without taking, and dropped when this goes away.** The read is
     idempotent because it happens twice for one press — `StrictMode`
     double-invokes the factory — and because a remount between the navigation
     and the first paint would otherwise hand the seed to the instance that is
     discarded. `start.tsx` has the measurement. */
  const seed = useMemo(() => seedWaiting(), []);
  useEffect(() => (seed ? () => dropSeed(seed) : undefined), [seed]);

  const { data: repos } = useRepos();
  const { data: allSkills } = useSkills();
  const { data: hosts } = useHosts();
  const { data: agents } = useAgents();
  const { data: accounts } = useAccounts();
  const profiles = useListRoles().data ?? [];
  const teams = useListAgentTeams().data ?? [];
  const create = useCreateSession();

  const [prompt, setPrompt] = useState(() => seeded(seed));
  /** Arrived from a task's *Start*, carrying what it was. */
  const task = !!(seed?.taskKey || seed?.taskUrl);
  const [checkouts, setCheckouts] = useState<Checkout[]>([]);
  const [where, setWhere] = useState<Where>(() => ({
    machine: "",
    hostId: "",
    agent: recall(LAST_AGENT) as Where["agent"],
  }));
  /* **One selection, not two.** A profile and a team are mutually exclusive —
     a team names its lead's profile on the server, and a team beside a
     different profile is refused there — so two pieces of state would be two
     things able to disagree about what is about to start. */
  const [startAs, setStartAs] = useState<StartAs>(null);
  // Start as the profile the person marked default, once the list is in — but
  // only the first time, so changing it here afterwards sticks. A default is a
  // profile's own flag and there is no team equivalent: entering a team is
  // explicit, which is what keeps "a profile started bare has no reach" true.
  const defaulted = useRef(false);
  useEffect(() => {
    if (defaulted.current || profiles.length === 0) return;
    defaulted.current = true;
    const def = profiles.find((p) => p.isDefault);
    if (def) setStartAs({ kind: "profile", id: def.id });
  }, [profiles]);
  const [accountId, setAccountId] = useState(() => recall(LAST_ACCOUNT));
  const [connecting, setConnecting] = useState(false);
  const [open, setOpen] = useState<{ which: string; at: HTMLElement } | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  // Dictation writes into the prompt like a second pair of hands, the same way
  // the conversation's composer takes it.
  const voice = useVoice({ text: prompt, setText: setPrompt, box });

  /* What is attached, under the rules in `~/ui/attach` — the same caps and the
     same refusal lines the conversation's composer applies, because a limit
     written twice is a limit that disagrees with itself within a release.

     A picture is read here and now: that is arithmetic on bytes the browser
     already has. Everything else keeps its `File` and goes nowhere yet —
     `attach_file` needs a workspace, and there is no workspace until `create`
     has answered and the worker has made one. `~/workspace/outbox` does that
     part, once there is somewhere to put them. */
  const [chips, setChips] = useState<Chip[]>([]);
  const [refused, setRefused] = useState<string | null>(null);
  const nextId = useRef(0);
  /* How many are held, read synchronously: two drops in the same tick both
     have to see the slots the other took, and state would not have landed yet.
     Reconciled from the real list after every render. */
  const held = useRef(0);
  useEffect(() => {
    held.current = chips.length;
  }, [chips]);

  const take = async (list: FileList | File[] | null, refusals: string[] = []) => {
    const offered = [...(list ?? [])];
    if (offered.length === 0 && refusals.length === 0) return;
    setRefused(null);
    const sifted = sift(held.current, offered, refusals);
    if (sifted.refusals.length) setRefused(sifted.refusals.join(" "));
    if (sifted.taken.length === 0) return;

    /* A picture's chip is pending until its bytes are read. A file's is not
       pending at all: nothing is going to happen to it on this page, so a
       spinner would be promising work that is not being done. */
    const made = sifted.taken.map((file) => {
      const picture = file.type.startsWith("image/");
      return { file, chip: { ...chipFor(nextId.current++, file, picture), file: picture ? undefined : file } };
    });
    held.current += made.length;
    setChips((all) => [...all, ...made.map((m) => m.chip)]);

    for (const { file, chip } of made) {
      if (chip.kind !== "image") continue;
      try {
        const data = await base64(file);
        setChips((all) =>
          all.map((c) => (c.id === chip.id ? { ...c, image: { mediaType: file.type, data }, pending: false } : c)),
        );
      } catch {
        setChips((all) => all.filter((c) => c.id !== chip.id));
        held.current = Math.max(0, held.current - 1);
        setRefused((was) => [was, `${file.name} could not be read.`].filter(Boolean).join(" "));
      }
    }
  };

  const unattach = (c: Chip) => {
    setChips((all) => all.filter((x) => x.id !== c.id));
    held.current = Math.max(0, held.current - 1);
  };

  /* The whole page, not the box. The composer is a strip in the middle of a
     tall empty page and the page is where a hand goes — the same reasoning,
     and the same hook, as the conversation pane. There is exactly one surface,
     because `drop` bubbles and a second handler inside this one would attach
     every file twice. */
  const { over, surface } = useFileDrop(({ files, folders }) => void take(files, folderRefusals(folders)));

  /** A picture still being read. The message is not complete without it. */
  const busy = chips.some((c) => c.pending);

  /* Arriving from "Create with AI", the composer is already half-written — put
     the cursor after it and grow the box, so the person just keeps typing.

     And arriving by ⌘N, the box takes focus empty: the gesture means "I want
     to say something", and landing on a screen with the cursor somewhere else
     makes somebody click before they can type. Not on an ordinary visit to
     the Dashboard, where the thing to read is the question an agent asked,
     not the box.

     **From a task, the cursor lands at the end of the first line** rather
     than at the end of the text. The last line is the issue URL, which is the
     one part nobody is going to edit; the title is the part you might. */
  const asked = usePathname().startsWith("/new");
  useEffect(() => {
    const el = box.current;
    if (!el || (!seed?.prompt && !task && !asked)) return;
    el.focus();
    const at = task && !seed?.prompt ? el.value.indexOf("\n") : -1;
    const caret = at < 0 ? el.value.length : at;
    el.setSelectionRange(caret, caret);
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 240) + "px";
  }, [seed?.prompt, task, asked]);

  /* A task seeds the repository once the server has mapped its slug to an id. */
  useEffect(() => {
    if (checkouts.length > 0 || repos.length === 0 || !seed?.repo) return;
    const wanted = repos.find((r) => r.slug === seed.repo);
    if (wanted) setCheckouts([{ id: wanted.id, slug: wanted.slug }]);
  }, [repos, seed?.repo, checkouts.length]);

  const all = useMemo(() => machines(hosts), [hosts]);
  const { host } = useMemo(() => resolve(hosts, where), [hosts, where]);
  const machine =
    all.find((m) => m.key === where.machine) ??
    (host ? all.find((m) => m.hosts.some((h) => h.id === host.id)) : undefined) ??
    all[0];

  // Skills: the ones that apply by default — always-on, or a default in a
  // repository you've added — unless you change the set.
  const defaultSkillIds = useMemo(
    () =>
      defaultSkills(allSkills, checkouts)
        .map((s) => s.id),
    [allSkills, checkouts],
  );
  /* What the start payload carries. There is no picker here and the comment
     beside the composer's controls says why — so this is the resolution and
     nothing overrides it. It used to be `skillIds ?? defaultSkillIds` behind
     a `useState` whose only setter lived in a popover nothing could open. */
  const selectedSkills = defaultSkillIds;

  /* **The profile that will actually run**, whichever way it was chosen. A
     team names its lead's profile too, because the lead *is* a profile — so
     the engine, the pinned settings and the skills resolve from one place
     either way. `create_session_as` makes the same resolution and refuses a
     team beside a different profile, so the two cannot disagree. */
  const everyStart = useMemo(() => startables(teams, profiles), [teams, profiles]);
  const start = startableIn(everyStart, startAs);
  /* **A held pick that has gone falls back rather than sticking**, which is
     what every other resolved default on this page does. A team's lead
     profile can be deleted, or the team filed away, while a composer sits
     open holding it — and sending it would be a refusal from the server
     about something this screen could already see. */
  const startable = start && !start.blocked ? start : undefined;
  const team =
    startable?.kind === "team" ? teams.find((t) => t.id === startable.id) : undefined;
  const profile = profiles.find(
    (p) => p.id === (startable?.kind === "team" ? team?.lead : startable?.id),
  );
  const pinned = (profile?.agent ?? undefined) as Agent | undefined;
  // A saved engine is used only while it still exists and is supported — one
  // that was uninstalled falls back rather than leaving a dead selection.
  const picked = agents.some((a) => a.kind === where.agent) ? (where.agent as Agent) : undefined;
  const kind = (pinned ||
    picked ||
    agents.find((a) => host && canRun(a, host.id))?.kind ||
    agents[0]?.kind) as Agent | undefined;

  const mine = useMemo(() => accounts.filter((a) => a.kind === kind && usable(a)), [accounts, kind]);
  const account = mine.find((a) => a.id === accountId);
  useEffect(() => {
    if (account || mine.length === 0) return;
    setAccountId((mine.find((a) => a.isDefault) ?? mine[0]).id);
  }, [account, mine]);

  /* Model, effort and permissions — the same picker the conversation uses,
     fed the choices Firetower knows for this agent before one is running. A
     fresh set each time the engine changes, since a model is one agent's. */
  const controlsQ = useAgentControls(kind ?? "", { query: { enabled: !!kind } });
  const controls = (kind ? (controlsQ.data ?? []) : []) as Control[];
  const [chosen, setChosen] = useState<Partial<Record<ControlKind, string>>>({});
  // Start from what the profile pins, when one is chosen and runs this engine —
  // the person can still change any of them before starting. Otherwise a clean
  // slate, so a change of engine never carries a stale model forward.
  useEffect(() => {
    const pins = profile?.agent === kind ? profile?.settings : undefined;
    const seed: Partial<Record<ControlKind, string>> = {};
    if (pins) {
      (["model", "effort", "mode", "sandbox"] as ControlKind[]).forEach((k) => {
        if (pins[k]) seed[k] = pins[k]!;
      });
    }
    setChosen(seed);
  }, [kind, profile?.id]);
  const valueOf = (c: Control) => chosen[c.kind] ?? c.current ?? undefined;

  const readiness = useHostReadiness(
    host?.id ?? "",
    { agent: kind },
    { query: { enabled: !!host && !!kind, retry: false, staleTime: 5000 } },
  );
  const hostReady = !!host && !!kind && isReady(readiness.data);
  /* `busy`: pressing Start while a picture is still being read would start a
     workspace and send it a message with the picture missing. */
  const ready = hostReady && !!account && !create.isPending && !busy;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) go();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /* Whether this page is still the one on screen by the time the create
     answers. It navigates on success, and somebody who has moved on — to
     another screen, or to another Firetower, which unmounts this — should not
     be pulled onto a workspace they stopped waiting for. The delivery below
     does not ask: that happens either way. */
  const onScreen = useRef(true);
  useEffect(() => {
    onScreen.current = true;
    return () => {
      onScreen.current = false;
    };
  }, []);

  /* **What this will be, computed in render rather than in `go`.** The branch
     is drawn in the footer before it is cut, and a branch shown on screen and
     a branch sent to the server that are computed in two places are two
     branches within a release. */
  const first = prompt.split("\n")[0].trim();
  const name = (seed?.title || first || checkouts[0]?.slug || "Workspace").slice(0, 80);
  const branch = checkouts.length ? branchFor(first || name, seed?.taskKey) : undefined;

  const go = () => {
    if (!ready || !kind || !account) return;
    // What was actually used, so the next New page opens on it.
    remember(LAST_AGENT, kind);
    remember(LAST_ACCOUNT, account.id);

    /* With something attached the prompt cannot ride along with the launch.
       `NewSession` carries text and nothing else, and the message this has to
       send is the text *plus* the pictures and the paths of the files — paths
       that do not exist until there is a workspace to put them in. So the
       prompt is held back and the whole first message is delivered by
       `~/workspace/outbox` once the agent is up.

       With nothing attached, none of that applies and this is exactly what it
       has always been: the prompt goes in the payload and the worker hands it
       to the agent as its opening prompt. */
    const images = chips.flatMap((c) => (c.image ? [c.image] : []));
    const files = chips.flatMap((c) => (c.file ? [c.file] : []));
    const attached = images.length > 0 || files.length > 0;
    /* Which Firetower this is being started on, read here rather than when the
       create answers. The client has one current backend and the sidebar can
       move it while the request is in flight, so reading it on the way back
       would address the parcel — the person's file — to the server they
       switched to. */
    const server = whichServer();

    /* `mutateAsync` rather than `mutate`'s `onSuccess`: switching Firetower
       unmounts this page (the provider is keyed on the server), and react-query
       does not call the callbacks passed to `mutate` once that has happened.
       The workspace is made regardless, so what was attached and what was typed
       would have gone nowhere with nobody told. This runs either way, and
       because the parcel carries the server it was started on, a window that
       has moved hears about it when it comes back rather than never. */
    void create
      .mutateAsync({
        data: {
          name,
          prompt: attached ? undefined : prompt.trim() || undefined,
          taskKey: seed?.taskKey,
          taskUrl: seed?.taskUrl,
          workspaceId: seed?.workspaceId as never,
          repos: checkouts.map((c) => ({ repoId: c.id })),
          agent: kind,
          /* **One of the two, never both.** A team names its lead's profile
             on the server; sending the profile as well would be the
             contradiction `create_session_as` refuses, and sending only the
             profile would start it bare with no reach — which is exactly the
             difference the picker just made visible. */
          profile: startable?.kind === "profile" ? startable.id : undefined,
          team: startable?.kind === "team" ? startable.id : undefined,
          accountId: account.id,
          branch,
          hostId: host?.id,
          skills: selectedSkills,
          settings: {
            model: chosen.model,
            effort: chosen.effort,
            mode: chosen.mode,
            sandbox: chosen.sandbox,
          },
        },
      })
      .then((made) => {
        const s = made as { id: string; workspaceId?: string | null };
        /* The words, in `draft.ts` as well as in the outbox. With something
           attached the prompt is not in the payload above — the first message
           has to be the text, the pictures and the paths together — so from
           here until the agent is listening the only copy of what was asked
           would otherwise be the one `post` holds, and a document that reloads
           under a long setup script takes it. A sentence is exactly what that
           handoff is for; the pictures cannot go in it and do not. Written
           before `post`, which takes it out again as soon as the attempt is
           over, whichever way it went.

           **The task's own line is not added here any more.** It used to be:
           the composer was never prefilled, so the title and the URL were
           handed over as a draft after the session started. They are in the
           prompt now, which means adding them here would hand the agent the
           same two lines twice — once as what was asked and once as a draft
           underneath it. Seeding the composer and this line are the same fact
           said in two places, and only one of them is visible before send. */
        const handoff = attached ? prompt.trim() : "";
        if (handoff) leaveDraft(s.id, handoff);
        /* The session's id, not the workspace's: a turn and an attachment are
           both addressed to the agent running in it. The workspace's too,
           though, because what gets read is a conversation chosen from the runs
           in it and a trouble has to reach whichever one that is. And the
           server, which is the one thing this page knows and the delivery
           cannot work out for itself. */
        if (attached) post({ server, sessionId: s.id, workspaceId: s.workspaceId }, { text: prompt.trim(), images, files });
        if (onScreen.current) navigate(`/sessions/${s.workspaceId ?? s.id}`);
      })
      .catch(() => {
        /* Said under the button, from the mutation's own state — which
           `mutateAsync` records as `mutate` does. Swallowed here because an
           unhandled rejection is not a second way of telling anybody. */
      });
  };

  const toggleRepo = (r: { id: string; slug: string }) =>
    setCheckouts((cs) =>
      cs.some((c) => c.id === r.id) ? cs.filter((c) => c.id !== r.id) : [...cs, { id: r.id, slug: r.slug }],
    );

  const close = () => setOpen(null);
  const toggle = (which: string, at: HTMLElement) =>
    setOpen((o) => (o?.which === which ? null : { which, at }));

  return (
    /* The surface is this wrapper rather than the scroller inside it: the
       overlay is positioned against it, and an overlay inside a scroller
       slides off the top as soon as the page is scrolled. */
    <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden" {...surface}>
      {over && <Dropping />}
      {!mid && children}

      <div className={mid ? "home" : "dock"}>
        <div className={mid ? "hcol" : "wrap"} data-bare={mid && bare ? "true" : undefined}>
          {/* **What the page says, when you arrived carrying something.** The
              greeting is stateless by design, and arriving from a task makes
              the loudest thing on the screen contradict the arrival. It names
              the task instead, and deliberately does not repeat the title —
              which is three inches below it, in the composer. */}
          {mid && (
            <div className="air">
              {task ? (
                <>
                  <h1>{taskHeadline(seed)}</h1>
                  <p className="hsub">
                    {seed?.repo
                      ? "Edit anything below, then send it."
                      : "This task names no repository, so there is nothing to check out yet."}
                  </p>
                </>
              ) : (
                above
              )}
            </div>
          )}
          <div className={mid ? "mid" : "contents"}>
          {/* What was not taken — too big, too many, a folder — in the words
              the conversation's composer uses for the same refusals. */}
          {refused && (
            <p className="mx-2.5 mb-2 flex items-center gap-2 text-meta text-brick">
              <X className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
              {refused}
            </p>
          )}

          {/* Only a blocker that needs *you* surfaces here. Readiness lives in
              the machine chip's menu, where the machine is.

              **One notice at a time, and the machine comes first.** An agent
              account cannot be checked without a machine to check it on —
              `hostReady` depends on `host` — so drawing both would report a
              fact nobody can yet know above the one thing that is actually
              stopping you. */}
          {all.length === 0 ? (
            /* **Amber, not ember.** Ember means an agent is waiting on you,
                and this is not that: it is a thing *you* have not done yet.
                `--color-amber-soft` for a mark on the page is the token's own
                stated job. The glyph is what makes it more than a hue. */
            <div className="mx-2.5 mb-2 flex items-center gap-3 rounded-xl border border-amber-deep bg-amber-tint px-3 py-2">
              <span className="grid shrink-0 place-items-center text-amber-soft">
                <Icon of={ServerOff} size={14} />
              </span>
              <span className="min-w-0 flex-1 text-meta text-bone">No machine to run on yet.</span>
              <button
                onClick={() => navigate("/configuration/machines/add")}
                className="control h-7 border border-line bg-panel text-meta text-bone hover:bg-raise"
              >
                <Icon of={Plus} size={12} />
                Add a machine
              </button>
            </div>
          ) : host && kind && mine.length === 0 ? (
            <div className="mx-2.5 mb-2 flex items-center gap-3 rounded-xl border border-amber-deep bg-amber-tint px-3 py-2">
              <span className="min-w-0 flex-1 text-meta text-bone">
                No {agents.find((a) => a.kind === kind)?.label ?? kind} account connected.
              </span>
              <button
                onClick={() => setConnecting(true)}
                className="control h-7 border border-line bg-panel text-meta text-bone hover:bg-raise"
              >
                <Icon of={Plus} size={12} />
                Connect an account
              </button>
            </div>
          ) : null}
          {create.isError && (
            <p className="mx-2.5 mb-2 rounded-xl border border-brick-deep bg-brick-tint px-3 py-2 text-meta text-brick">
              {(create.error as { code?: string })?.code === "NoCapacity"
                ? "No host is available to take this."
                : ((create.error as { message?: string })?.message ?? "Couldn't start it.")}
            </p>
          )}

          {/* The shelf: what the workspace will be made of. */}
          <div className="shelf">
            {/* **Given, not chosen — and first, because it is why you are
                here.** `taskKey` and `taskUrl` are parameters of the workspace
                exactly as the repository and the machine are, and they travel
                into `NewSession` beside them. It wears a link-out glyph and
                **no chevron**: the other two are pickers, this one arrived
                with you and cannot be changed here. The missing chevron is the
                statement — the drawing makes the same point by dropping the
                ring these chips carry there, which has no analogue here
                because ours carry none. */}
            {task && (
              <button
                onClick={() => seed?.taskUrl && void openExternal(seed.taskUrl)}
                disabled={!seed?.taskUrl}
                data-set="true"
                data-given="true"
                className="chip"
                title={seed?.taskUrl ? `${seed.taskKey ?? "The task"} — opens the tracker` : (seed?.taskKey ?? "The task")}
              >
                <span className="grid place-items-center text-mute">
                  <Icon of={CircleAlert} size={14} />
                </span>
                <span className="lbl">{seed?.taskKey ?? seed?.issue ?? "The task"}</span>
                {seed?.taskUrl && <Icon of={ExternalLink} size={12} className="text-mute" />}
              </button>
            )}
            <button
              onClick={(e) => toggle("repo", e.currentTarget)}
              data-set={checkouts.length > 0}
              data-which="repo"
              className="chip"
              title="Which repositories this workspace checks out"
            >
              <span className="grid place-items-center text-mute">
                <Icon of={FolderGit2} size={14} />
              </span>
              <span className="lbl">
                {checkouts.length === 0
                  ? "Add a repository"
                  : checkouts.length === 1
                    ? checkouts[0].slug
                    : `${checkouts.length} repositories`}
              </span>
              <Icon of={ChevronDown} size={12} className="text-mute" />
            </button>
            <button
              onClick={(e) => toggle("machine", e.currentTarget)}
              data-set={!!where.machine}
              data-which="machine"
              className="chip"
              title={machine ? "Where it runs" : "No machine to run on"}
            >
              {/* **No hue on the chip, and a different glyph instead.** One
                  coloured object for one fact — the notice above — and the
                  chip agrees with it by *shape*. That is "never hue alone"
                  honoured in both directions at once. It read "Where it runs"
                  in `--color-dim`, which is indistinguishable from "Add a
                  repository" beside it. */}
              <span className="grid place-items-center text-mute">
                <Icon of={machine ? Server : ServerOff} size={14} />
              </span>
              {/* The whole name on the label, because the label is the part
                  that gets cut — the button keeps saying what it *does*, so
                  hovering the chevron still explains the control and hovering
                  the name reads it back in full. */}
              <span className="lbl" title={machine ? machineLabel(machine) : undefined}>
                {machine ? machineLabel(machine) : "No machine"}
              </span>
              {host && kind && (
                <span
                  className={`h-[5px] w-[5px] shrink-0 rounded-full ${hostReady ? "bg-sage" : "bg-amber-soft"}`}
                  title={hostReady ? "Ready" : "Needs setup — open to see"}
                />
              )}
              <Icon of={ChevronDown} size={12} className="text-mute" />
            </button>
          </div>

          <div className="composer">
            <Chips chips={chips} onDrop={unattach} className="pb-3" />
            <textarea
              ref={box}
              value={prompt}
              onChange={(e) => {
                setPrompt(e.target.value);
                voice.typed(e.target.value);
                const el = e.target;
                el.style.height = "auto";
                el.style.height = Math.min(el.scrollHeight, 240) + "px";
              }}
              onKeyDown={(e) => {
                if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
                // Enter sends; a modifier makes a newline. Cmd/Ctrl+Enter is the
                // one asked for; Shift+Enter keeps its native newline so it never
                // sends by surprise.
                if (e.shiftKey) return;
                if (e.metaKey || e.ctrlKey) {
                  e.preventDefault();
                  const el = e.currentTarget;
                  const at = el.selectionStart ?? prompt.length;
                  const end = el.selectionEnd ?? at;
                  const next = prompt.slice(0, at) + "\n" + prompt.slice(end);
                  setPrompt(next);
                  voice.typed(next);
                  requestAnimationFrame(() => {
                    el.selectionStart = el.selectionEnd = at + 1;
                    el.style.height = "auto";
                    el.style.height = Math.min(el.scrollHeight, 240) + "px";
                  });
                  return;
                }
                e.preventDefault();
                go();
              }}
              onPaste={(e) => {
                // A screenshot straight off the clipboard, as the conversation
                // takes one. Text pastes are left entirely alone.
                if (e.clipboardData.files.length) void take(e.clipboardData.files);
              }}
              placeholder="Start something new…"
              rows={1}
              className="in scroll-slim resize-none bg-transparent placeholder:text-mute focus:outline-none"
            />

            {/* The footer: who does the work, and how. */}
            <div className="bar">
              <label className="chip cursor-pointer" title="Attach a file or an image">
                <Paperclip className="h-4 w-4" strokeWidth={1.75} />
                <input type="file" multiple className="hidden" onChange={(e) => void take(e.target.files)} />
              </label>

              {/* **No skills chip here.** The drawing has one in a workspace
                  and not on the Dashboard, and the reason holds: starting
                  something, the profile decides what it reads, and a count of
                  skills is a number about a decision you have not made yet.
                  Replying, you can see what it read and change it. */}
              <button
                onClick={(e) => toggle("profile", e.currentTarget)}
                data-set={!!profile}
                className="chip"
                /* The consequence, reachable without opening anything: the
                   one-agent-or-eight distinction is what somebody comes back
                   to this chip to check. */
                title={consequence(start) ?? "Which profile the agent wears"}
              >
                <span className="grid place-items-center text-mute">
                  {pinned ? <AgentMark agent={pinned} size={15} /> : <UserRound className="h-[15px] w-[15px]" strokeWidth={1.8} />}
                </span>
                {/* **The lead's name, with its team beside it.** You never
                    talk to a team — you talk to its lead — so the chip says
                    who is about to answer, and the team is what is behind it.
                    Two spans rather than a middle dot, which `STYLE.md` rules
                    out for exactly this. */}
                <span className="lbl">{profile ? profile.name : "Just an agent"}</span>
                {team && <span className="shrink-0 text-mute">in {team.name}</span>}
                <Icon of={ChevronDown} size={12} className="text-mute" />
              </button>
              {kind && (
                <RunPicker
                  agent={kind}
                  agentLabel={agents.find((a) => a.kind === kind)?.label}
                  agents={agents.filter((a) => a.supported).map((a) => ({ kind: a.kind, label: a.label }))}
                  accounts={mine.map((a) => ({ id: a.id, name: a.name, isDefault: a.isDefault }))}
                  accountId={account?.id ?? ""}
                  agentLocked={!!pinned}
                  controls={controls}
                  valueOf={valueOf}
                  onPickAgent={(k) => setWhere({ ...where, agent: k })}
                  onPickAccount={(id) => setAccountId(id)}
                  onPickControl={(k, v) => setChosen((p) => ({ ...p, [k]: v }))}
                />
              )}
              {/* **The branch, before you commit to it rather than after.**
                  Mono, quiet, and it tracks the first line as you type, so
                  editing the title is visibly editing the branch. It is drawn
                  only from a task, because that is the arrival where what is
                  about to happen is not otherwise on the screen.

                  `margin-left: auto` so it right-aligns whether or not
                  dictation is available on this machine; the mic keeps its
                  own, which does nothing once this has taken the slack. */}
              {task && (
                <span
                  className="br"
                  title={branch ? `The branch this will be cut on` : "Nothing is checked out, so there is no branch to cut"}
                >
                  <Icon of={GitBranch} size={12} />
                  {branch ? <b>{branch}</b> : "no branch — nothing checked out"}
                </span>
              )}

              {/* **At the right-hand end**, where the drawing puts it: the
                  chips on the left are what this run will be, and dictation
                  is a way of typing — it belongs beside the thing it types
                  into, not in the middle of the settings. */}
              {voice.possible && (
                <span className="ml-auto">
                  <Mic state={voice.state} onStart={voice.start} onStop={voice.stop} />
                </span>
              )}
              {/* Already disabled, correctly, by `ready`. Its title said
                  **Start it** either way, which is the one thing it cannot
                  do. */}
              <button
                onClick={go}
                disabled={!ready}
                title={
                  busy
                    ? "Waiting for the images"
                    : all.length === 0
                      ? "Add a machine first"
                      : "Start it   ⏎"
                }
                aria-label={all.length === 0 ? "Add a machine first" : "Start it"}
                className="send"
              >
                <ArrowUp className="h-[17px] w-[17px]" strokeWidth={2.5} />
              </button>
            </div>
          </div>
          </div>
          {/* The sections the home puts under the composer. */}
          {mid && children}
        </div>
      </div>

      {/* ---------- the pill menus ---------- */}
      {open?.which === "profile" && (
        <Pop anchor={open.at} onClose={close} width={320}>
          <ProfileMenu
            profiles={profiles}
            teams={teams}
            startAs={startAs}
            onPick={(next) => {
              setStartAs(next);
              close();
            }}
          />
        </Pop>
      )}

      {open?.which === "repo" && (
        <Pop anchor={open.at} onClose={close} width={340}>
          <RepoMenu repos={repos} checkouts={checkouts} onToggle={toggleRepo} onClose={close} />
        </Pop>
      )}

      {open?.which === "machine" && (
        <Pop anchor={open.at} onClose={close} width={340}>
          <Menu>
            {/* The shared block, which has somewhere to go: this said "No
                machine connected." and left whoever read it in a menu with
                nothing in it. */}
            {all.length === 0 && (
              <NoMachine
                onAddMachine={() => {
                  close();
                  navigate("/configuration/machines/add");
                }}
              />
            )}
            {all.map((m) => (
              <Opt
                key={m.key}
                on={m.key === machine?.key}
                onPick={() => {
                  setWhere({ machine: m.key, hostId: "", agent: where.agent });
                  close();
                }}
                icon={<Server className="h-4 w-4" strokeWidth={1.8} />}
                title={machineLabel(m)}
              />
            ))}
          </Menu>
          {/* Outside the scroller: it is what the machine you picked is up to,
              not another machine to pick, and it has to stay readable while a
              long list of them scrolls under the pointer. */}
          {host && kind && (
            <div className="shrink-0 border-t border-line-soft py-1">
              <Readout
                key={`${host.id}:${kind}`}
                host={host}
                agent={kind}
                agentLabel={agents.find((a) => a.kind === kind)?.label}
              />
            </div>
          )}
        </Pop>
      )}

      {connecting && kind && agents.some((a) => a.kind === kind) && (
        <ConnectAccount
          agent={agents.find((a) => a.kind === kind)!}
          onClose={() => setConnecting(false)}
        />
      )}

      {voice.blocked && (
        <VoiceDialog
          blocked={voice.blocked}
          onDismiss={voice.dismiss}
          onConfigure={voice.configure}
        />
      )}
    </div>
  );
}

/* ---------------- small building blocks ---------------- */

function Pill({
  icon,
  label,
  sub,
  lock,
  set,
  after,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  sub?: string;
  lock?: string;
  set?: boolean;
  after?: React.ReactNode;
  onClick: (el: HTMLElement) => void;
}) {
  return (
    <button
      onClick={(e) => onClick(e.currentTarget)}
      className="group inline-flex h-8 items-center gap-2 rounded-lg px-2 text-meta transition-colors hover:bg-raise/60"
    >
      <span className={set ? "text-slate" : "text-mute"}>{icon}</span>
      <span className={set ? "text-bone" : "text-dim group-hover:text-text"}>{label}</span>
      {sub && <span className="text-mute">{sub}</span>}
      {lock && <span className="text-sage/90">· {lock}</span>}
      {after}
      <ChevronDown className="h-3 w-3 text-mute/60 transition-colors group-hover:text-mute" strokeWidth={2} />
    </button>
  );
}

/**
 * Which repositories a query leaves.
 *
 * By slug and case-insensitively, which is how everybody types a repository
 * name — and on a substring rather than a prefix, because a slug is
 * `owner/name` and the half anybody remembers is the second one. Exported for
 * its own test: the rule is one line and silently wrong if the fold or the
 * trim goes missing.
 */
export function matching<T extends { slug: string }>(repos: T[], q: string): T[] {
  const query = q.trim().toLowerCase();
  return query ? repos.filter((r) => r.slug.toLowerCase().includes(query)) : repos;
}

/**
 * The repository list — the longest list on this page, and the one that was
 * reported.
 *
 * The sheet this page replaced filtered from the first repository and this does
 * too, because a connected account brings every repository it can see and
 * scrolling to one by name is not a thing anybody wants to do twice. The only
 * case without a box is the one with nothing to filter.
 *
 * Unlike the profile menu this is a multi-select, so picking leaves the menu
 * and the query where they are: the row you just ticked stays in front of you.
 * Remounts each time the menu opens, so the search starts empty.
 */
export function RepoMenu({
  repos,
  checkouts,
  onToggle,
  onClose,
}: {
  repos: { id: string; slug: string; defaultBranch?: string | null }[];
  checkouts: Checkout[];
  onToggle: (r: { id: string; slug: string }) => void;
  onClose: () => void;
}) {
  return (
    <>
      {/* The box, the filtering and the empty line are `Sift`'s — there is
          one of them in the product. What a query *means* is this list's:
          `matching` folds case and looks at the slug, which is the half of
          `owner/name` anybody remembers. */}
      <Sift
        items={repos}
        match={(r, q) => matching([r], q).length > 0}
        when={repos.length > 0}
        placeholder="Search repositories"
        noun="repository"
        onlyOne={onToggle}
      >
        {(shown) => (
          <>
            {/* **The shape `NoMachine` uses, because it is the same moment.**
                A line of grey saying "No repositories connected." states the
                problem and withholds the remedy, and this is the menu you
                opened looking for one. It names no host: which provider this
                install uses is not ours to assume, so it sends you to the
                page where every one of them is. */}
            {repos.length === 0 && (
              <div className="px-3 py-3">
                <p className="text-ui text-bone">No repository connected</p>
                <p className="mt-1 max-w-[46ch] text-meta text-dim">
                  Workspaces are cut from a repository you connect. You can start without one.
                </p>
                <button
                  onClick={() => {
                    onClose();
                    navigate("/configuration/repositories");
                  }}
                  className="control mt-2.5 border border-line bg-panel text-ui text-bone hover:bg-overlay"
                >
                  Connect a repository
                </button>
              </div>
            )}
            {shown.map((r) => (
              <Opt
                key={r.id}
                on={checkouts.some((c) => c.id === r.id)}
                onPick={() => onToggle(r)}
                keepOpen
                icon={<FolderGit2 className="h-4 w-4" strokeWidth={1.8} />}
                title={r.slug}
                sub={r.defaultBranch ?? undefined}
              />
            ))}
          </>
        )}
      </Sift>
      {/* What ticking another one actually does. Outside the scroller, so it
          stays put while the list moves under the pointer.

          Not drawn when there is nothing to tick: the block above already
          says there is no repository, and saying it twice in forty pixels
          reads as two different facts until you have read both. */}
      {repos.length > 0 && (
      <div className="pkfoot">
        {checkouts.length === 0 ? (
          "No repository: a bare workspace with no code in it."
        ) : (
          <>
            <b>{checkouts.length} checked out.</b> Each one gets its own copy of the code, cut from its
            default branch.
          </>
        )}
      </div>
      )}
    </>
  );
}

/**
 * What a composer will start as: a lone profile, an agent team, or neither.
 *
 * **A team is entered explicitly.** A profile that happens to lead a team does
 * not pick that team up by being named bare — `docs/agent-teams.md` and
 * `NewSession.team` are the server half of the same rule — so these are two
 * kinds of choice and not one with a flag on it. `null` is *Just an agent*,
 * which is a value and not a dismissal.
 */
export type StartAs = { kind: "profile" | "team"; id: string } | null;

/**
 * One row the picker offers.
 *
 * **A position is never one of these.** A position only means something inside
 * its tree: it is not a thing you can start work as, and the only way to reach
 * one is through the team that holds it. This type is built from the team list
 * and the profile list and from nothing else, which is how that stays true
 * rather than being remembered.
 */
export type Startable = {
  kind: "profile" | "team";
  id: string;
  /** The row's title: the team's name, or the profile's. */
  name: string;
  /** The profile that will actually run — a team's lead, or the profile. */
  lead: string | null;
  /**
   * **How many agents the run has: a team's lead and what it can hand work
   * to, or one.**
   *
   * `AgentTeam.reports`, plus the lead, and deliberately **not**
   * `AgentTeam.positions`. `positions` is every seat in the whole tree,
   * unfiltered, which is what the map and the list row are for; it overstates
   * what picking this row gets you in two independent ways. Reach descends
   * exactly one level per hand-off, so the seats below a report are somebody
   * else's to reach later, through a hand-off this person is not making; and
   * a seat whose profile this person cannot see is not a report at all —
   * `AgentTeams::reports` drops it, and so does the persona the agent is
   * given. A team of seven seats whose lead has two reachable reports said
   * *six other agents* and gave two.
   *
   * This is the moment of choosing, and picking the team rather than the bare
   * profile is the difference between one agent and eight. That difference is
   * the only thing the row is for, so the number has to be the one the spawn
   * will resolve against.
   */
  agents: number;
  /** The engine the profile that runs pins, when it pins one. */
  agent?: string | null;
  /** The second line. What a profile does, or who leads a team. */
  does?: string;
  /** Why this cannot be started, when it cannot. */
  blocked?: string;
  /**
   * The old per-profile reach, which agent teams replace.
   *
   * Still live during the compatibility window: a Manager profile started
   * bare does still hand work out, so the sentence under the box may not say
   * it cannot. Goes with `roles.can_delegate` in #497.
   */
  delegates?: boolean;
};

/**
 * Everything the picker offers, in the order it offers it.
 *
 * **Teams group above profiles**, and that is not a new preference: the picker
 * already floated the delegating profiles to the top, because the lead you
 * would start a board as is the one you reach for most. Reach has moved off
 * the profile and onto the team, so that position moves with it.
 *
 * **And within the profiles, the old sort survives for as long as the old
 * reach does.** That is the correction: moving the preference onto teams is
 * right *after* the compatibility window, and during it a Manager profile
 * started bare genuinely still hands work out — which is the same fact that
 * earns it a chip and its own sentence in [`consequence`]. Three things
 * saying *this one delegates* and a sort saying nothing is one of them
 * wrong. So a profile that can still reach somebody still files with the
 * ones that can, and the guard dies with `roles.can_delegate` in #497
 * alongside the sentence — one field, one removal, one story.
 *
 * Then alphabetical, `localeCompare` so an accented name files where a person
 * would look for it.
 *
 * **A profile that leads a team appears twice** — once bare and once as the
 * team — and that is deliberate. The two start completely different things:
 * picking the profile gets one agent that cannot delegate at all, picking the
 * team gets that same profile with its reports reachable. Showing it once
 * would mean one row standing for two outcomes, with nothing on screen saying
 * which you were about to get.
 *
 * A team and a profile that share a name — common, because a team is often
 * named after what its lead does — are told apart by the group labels. Neither
 * is renamed.
 */
export function startables(teams: AgentTeam[], profiles: Role[]): Startable[] {
  const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);
  /* Delegating profiles first while any of them still delegate, then by name.
     `Number(…)` because `canDelegate` is a boolean and a comparator needs a
     number. Goes with #497. */
  const byReach = (a: Role, b: Role) =>
    Number(b.canDelegate) - Number(a.canDelegate) || byName(a, b);

  const asTeam = (t: AgentTeam): Startable => {
    const lead = t.lead ? profiles.find((p) => p.id === t.lead) : undefined;
    return {
      kind: "team",
      id: t.id,
      name: t.name,
      lead: t.leadName ?? null,
      agents: t.reports + 1,
      agent: lead?.agent ?? null,
      /* **Its lead, named before it is picked.** If the picker says *Growth*
         and the conversation opens with the Orchestrator, the row misled
         somebody about the one thing it was for. */
      does: t.leadName ? `Led by ${t.leadName}` : undefined,
      /* Two real states, both of which would fail at the launch rather than
         here. A team whose lead profile was deleted has no root position to
         stand in; one whose lead is filed somewhere this person cannot reach
         has nothing they could be started as. */
      blocked: !t.lead
        ? "It has no lead, so there is nobody to start"
        : t.leadName
          ? undefined
          : "Its lead isn't a profile you can use",
    };
  };

  return [
    ...[...teams].sort(byName).map(asTeam),
    ...[...profiles].sort(byReach).map((p) => ({
      kind: "profile" as const,
      id: p.id,
      name: p.name,
      lead: p.name,
      agents: 1,
      agent: p.agent ?? null,
      does: p.does,
      delegates: p.canDelegate,
    })),
  ];
}

/** Whichever of the two kinds is in force, or nothing. */
export function startableIn(all: Startable[], start: StartAs): Startable | undefined {
  return start ? all.find((s) => s.kind === start.kind && s.id === start.id) : undefined;
}

/**
 * Whether a query leaves a row.
 *
 * The name, what it does, and for a team its lead — because the lead is what
 * somebody remembers about a team they set up months ago, and it is what the
 * row is about.
 */
export function startableMatches(s: Startable, q: string): boolean {
  return looselyMatches(`${s.name} ${s.does ?? ""} ${s.lead ?? ""}`, q);
}

/**
 * **What picking this would actually do**, said under the list rather than
 * discovered afterwards.
 *
 * The behavioural difference between the two kinds is the largest thing in
 * this picker and the whole reason a team is a row of its own: a profile
 * started on its own cannot delegate at all, while a team starts its lead
 * with its members reachable. One agent, or eight. So the sentence names the
 * lead, names the team it leads, and counts what it can reach.
 *
 * `null` is not a selection and gets no consequence — the row already says
 * *no profile, a plain workspace*, and the footer is then free to say what
 * profiles are for, which is what somebody meeting an empty list needs.
 */
export function consequence(s: Startable | undefined): string | null {
  if (!s) return null;
  /* **A row there is nothing to start says so**, rather than a sentence about
     a lead it does not have. Reachable without picking one: a team's lead
     profile can be deleted while a composer is open holding it. */
  if (s.blocked) return `${s.name} can't be started. ${s.blocked}.`;
  if (s.kind === "team") {
    const lead = s.lead ?? "its lead";
    /* **What this run will be able to hand work to**, which is a property of
       the lead's seat and not of the team: `Startable.agents` is the lead
       plus its own reachable reports, so this is `AgentTeams::reports` and
       the number the spawn resolves against. It used to be the whole tree,
       unfiltered. */
    const others = Math.max(0, s.agents - 1);
    if (others === 0) {
      return `Starts ${lead}, ${s.name}'s lead. Nothing reports to it yet, so it cannot hand work to anybody.`;
    }
    return `Starts ${lead}, ${s.name}'s lead. It can hand work to ${others} other agent${
      others === 1 ? "" : "s"
    } in the team.`;
  }
  /* **The compatibility window, said plainly.** A Manager profile started
     bare still hands work out through its own older settings, so "it cannot
     hand work to anybody" would be false of it. This clause goes with
     `roles.can_delegate` in #497, and the sentence above it is the one that
     survives. */
  if (s.delegates) {
    return `Starts ${s.name} on its own. Its own profile still lets it hand work out, which an agent team replaces.`;
  }
  return `Starts ${s.name} on its own. It cannot hand work to anybody.`;
}

/**
 * **What the footer says**, which is the consequence of the row that is on —
 * including the one that is on when nothing has been picked.
 *
 * `consequence` answers for a `Startable` and `null` is not one: *Just an
 * agent* is a row rather than a dismissal, so it has a consequence like every
 * other row and this is where it is said.
 *
 * The four-line paragraph about what profiles are for is kept for the person
 * it was written for — somebody meeting an **empty** list — and shown on the
 * same condition as the *Create a profile* button under it, so the two cannot
 * disagree about who is being spoken to. It used to appear whenever nothing
 * was picked, which on a 1280x824 window cost 127px of a 392px card and left
 * the Profiles group cut through its own heading with no profile row below
 * it: the teaching text was pushing off the screen the thing it was teaching
 * about. The footer is now one or two lines in every state, so the card stops
 * changing height as somebody moves down the list.
 */
export function pickerFooter(picked: Startable | undefined, profiles: number): string {
  if (picked) return consequence(picked) ?? "";
  if (profiles > 0) {
    return "Starts a plain workspace. No profile, so there is nobody to hand work to.";
  }
  return (
    "You can create agent profiles to divide your work across teams of agents (e.g. a " +
    "designer, an engineer, a security advisor, a QA, etc.) Put them in an agent team and " +
    "its lead can hand work to the rest."
  );
}

/**
 * The teams and the profiles, in one list, which grows — so once there are
 * more than a handful this filters. Remounts each time the menu opens, so the
 * search box starts empty.
 *
 * **It is still `ProfileMenu`, and that is the right name.** You never talk to
 * a team: you talk to its lead, with its team behind it. So every row here
 * ends in a profile, and a team is how you pick one that has a team behind it
 * — which is exactly what the chip this drops from says it is for.
 */
export function ProfileMenu({
  profiles,
  teams,
  startAs,
  onPick,
}: {
  profiles: Role[];
  teams: AgentTeam[];
  startAs: StartAs;
  onPick: (next: StartAs) => void;
}) {
  const all = useMemo(() => startables(teams, profiles), [teams, profiles]);
  const picked = startableIn(all, startAs);
  /* The labels exist to tell a team from a profile of the same name. With no
     teams at all there is nothing to tell apart, so this menu looks exactly
     as it did — one list, no headings over it. */
  const grouped = teams.length > 0;

  return (
    <>
      {/* The same box as the repository menu, from the same place. What a
          query means here is the name, what the profile *does*, and a team's
          lead — which is how somebody looks for one they set up months ago. */}
      <Sift
        items={all}
        match={startableMatches}
        when={all.length > 3}
        placeholder={grouped ? "Search teams and profiles" : "Search profiles"}
        noun={grouped ? "team or profile" : "profile"}
        onlyOne={(s) => !s.blocked && onPick({ kind: s.kind, id: s.id })}
      >
        {(shown, query) => {
          const rows = (kind: Startable["kind"]) => shown.filter((s) => s.kind === kind);
          return (
            <>
              {/* Only with nothing typed: *Just an agent* is neither a team
                  nor a profile and cannot match a search for one. */}
              {!query.trim() && (
                <Opt
                  on={!startAs}
                  onPick={() => onPick(null)}
                  icon={<UserRound className="h-4 w-4" strokeWidth={1.8} />}
                  title="Just an agent"
                  sub="No profile — a plain workspace"
                />
              )}
              {(["team", "profile"] as const).map((kind) => {
                const group = rows(kind);
                if (group.length === 0) return null;
                return (
                  <div key={kind}>
                    {grouped && <Head>{kind === "team" ? "Agent teams" : "Profiles"}</Head>}
                    {group.map((s) => (
                      <Opt
                        key={`${s.kind}:${s.id}`}
                        on={s.kind === startAs?.kind && s.id === startAs.id}
                        disabled={!!s.blocked}
                        onPick={() => !s.blocked && onPick({ kind: s.kind, id: s.id })}
                        icon={
                          s.agent ? (
                            <AgentMark agent={s.agent as Agent} size={16} />
                          ) : s.kind === "team" ? (
                            <Users className="h-4 w-4" strokeWidth={1.8} />
                          ) : (
                            <UserRound className="h-4 w-4" strokeWidth={1.8} />
                          )
                        }
                        title={s.name}
                        sub={s.blocked ?? s.does}
                        /* **The size, before it is picked.** One agent or
                           eight is the difference this row has to carry, and
                           the count is the shortest true way to say it. */
                        chip={
                          s.kind === "team"
                            ? `${s.agents} agent${s.agents === 1 ? "" : "s"}`
                            : s.delegates
                              ? "can delegate"
                              : undefined
                        }
                      />
                    ))}
                  </div>
                );
              })}
            </>
          );
        }}
      </Sift>
      {/* **What picking this would do, or what they are for.**
          `RepoMenu`'s footer says what ticking another repository does; this
          is the same job: one agent, or a lead with its team reachable. That
          sentence is the whole argument for a team being a row of its own, so
          it is never shortened to make room — what gives way is the list,
          which scrolls, and `pickerFooter` is where the two are weighed.
          The route out of an empty list is the Profiles page: making one
          there is two choices, which is not a thing to reproduce inside a
          menu. */}
      <div className="pkfoot shrink-0">
        <p>{pickerFooter(picked, profiles.length)}</p>
        {profiles.length === 0 && (
          <button
            onClick={() => navigate("/configuration/roles")}
            className="control mt-2.5 border border-line bg-panel text-ui text-bone hover:bg-overlay"
          >
            Create a profile
          </button>
        )}
      </div>
    </>
  );
}

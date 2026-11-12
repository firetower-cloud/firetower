/**
 * Making one, as a sheet.
 *
 * **A sheet, not the composer dock.** What this is about is not on the page
 * behind it, and the dock is for starting work now — pressing Enter there
 * sends it. Here Enter inserts a newline and nothing submits, because the
 * prompt is a paragraph somebody is writing for an agent that cannot ask a
 * follow-up question. That is the one behaviour this does not share with the
 * composer.
 *
 * **Everything else is the composer's own control, imported.** The
 * repositories menu, the machine menu, the profile menu, what runs it and the
 * skills list are the components the Dashboard uses — `RepoMenu`,
 * `ProfileMenu`, `Menu`/`Opt`, `RunPicker`, `Pop`, `Readout` — not lookalikes
 * of them. A rebuilt control is a control that drifts from the product the
 * first time somebody changes the real one, and this sheet shipped with five
 * of them: a native `<select>` for the repository that could hold one, a
 * machine that was a sentence rather than a picker, no model and no account at
 * all, and a Skills row that only said what *would* happen.
 *
 * **The body scrolls, all of it.** A consequence summary used to be pinned
 * above the footer so it could not be scrolled away; it read as the bottom of
 * the sheet, which hid the fact that there was anything below the fold at all.
 * It was then the last card in the body, and now it is not here: every row of
 * it restated a control a few inches above or was true of every schedule ever
 * made. The controls are the disclosure. The proposal review keeps its own
 * copy, for a reason that is about that screen — see the note where this one
 * used to be.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  Diamond,
  FolderGit2,
  Server,
  ServerOff,
  TriangleAlert,
  UserRound,
  X,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Icon, IconButton } from "~/components/ui";
import { AgentMark } from "~/components/AgentMark";
import { Pop } from "~/ui/Pop";
import { RunPicker } from "~/ui/RunPicker";
import { ProfileMenu, RepoMenu } from "~/ui/StartComposer";
import { Head, Menu, Opt, PickOne } from "~/ui/menus";
import { canRun, NoMachine, resolve, type Where } from "~/components/WhereItRuns";
import { Readout } from "~/components/HostReadiness";
import { machineLabel, machines } from "~/api/environments";
import { usable } from "~/api/accounts";
import { useAccounts, useAgents, useHosts, useRepos, useSkills } from "~/data";
import { navigate } from "~/shims/next-navigation";
import { useListRoles } from "~/api/generated/roles/roles";
import { useAgentControls } from "~/api/generated/agents/agents";
import { getListSchedulesQueryKey, readCadence } from "~/api/generated/schedules/schedules";
import { createAndTurnOn, saveEdits } from "./create";
import { unattendedValue } from "./controls";
import type {
  Agent,
  Cadence,
  CadenceAnswer,
  Control,
  ControlKind,
  Schedule,
  Weekday,
} from "~/api/generated/model";
import type { Example } from "./examples";
import { fires } from "./view";

/** The five. Custom is last, and it is the only one that takes an expression. */
const CADENCES: { kind: Cadence["kind"]; label: string; note?: string }[] = [
  { kind: "daily", label: "Every day" },
  { kind: "weekdays", label: "Weekdays", note: "Monday to Friday" },
  { kind: "weekly", label: "Every week", note: "Choose a day" },
  { kind: "monthly", label: "Every month", note: "A date, or a weekday" },
  { kind: "custom", label: "Custom", note: "Cron expression" },
];

const DAYS: Weekday[] = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

/** `monday` as somebody reads it. */
const titled = (word: string) => word[0].toUpperCase() + word.slice(1);

type Checkout = { id: string; slug: string };

export function NewSchedule({
  from,
  editing,
  copyOf,
  onClose,
}: {
  from: Example | null;
  /**
   * The schedule being changed, where this is an edit rather than a new one.
   *
   * **The same sheet, which is the whole design.** There is one set of
   * controls for what a schedule is, and an edit screen of its own would be a
   * second one to keep in step. What differs is three words and where Save
   * goes.
   *
   * Everything it fills in comes from [`Schedule`] — including `choices`,
   * which is the approved engine, subscription, profile, controls and skills.
   * Nothing exposed those before, so this form could only have reset them to
   * whatever a fresh one defaults to.
   */
  editing?: Schedule | null;
  /**
   * A schedule to copy: every control filled in from it, and **Create writes
   * a new one**.
   *
   * The same prefill as an edit and a different act, which is why it is a
   * second prop rather than a flag — `editing` is what decides where Save
   * goes, and conflating the two would make a copy overwrite the thing it
   * was copied from. `create_schedule`'s own doc already counted a copy among
   * the things that merely create, and so arrive switched off.
   */
  copyOf?: Schedule | null;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const { data: repos } = useRepos();
  const { data: allSkills } = useSkills();
  const { data: hosts } = useHosts();
  const { data: agents } = useAgents();
  const { data: accounts } = useAccounts();
  const profiles = useListRoles().data ?? [];

  /* What this sheet opens on. An edit and a copy fill in from the same
     place; only where Save goes differs. */
  const like = editing ?? copyOf ?? null;
  const [name, setName] = useState(
    // A copy says so in its name: two rows called the same thing, one of them
    // off, is a list nobody can read.
    (copyOf ? `${copyOf.name} (copy)` : editing?.name) ?? from?.name ?? "",
  );
  const [prompt, setPrompt] = useState(like?.prompt ?? from?.prompt ?? "");
  const [checkouts, setCheckouts] = useState<Checkout[]>(
    like ? like.repos.map((r) => ({ id: r.id, slug: r.slug })) : [],
  );
  const [profileId, setProfileId] = useState<string | null>(like?.choices.profile ?? null);
  const [base, setBase] = useState(like?.base ?? "");
  // Open where there is something in it to see.
  const [advanced, setAdvanced] = useState(!!like?.base);
  const [deleteClean, setDeleteClean] = useState(like?.deleteCleanRuns ?? true);
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  /** Which menu is open, and what it drops from. The composer's own idiom. */
  const [open, setOpen] = useState<{ which: string; at: HTMLElement } | null>(null);

  /* ── What runs it: the machine, the engine, the account, the controls ──
     The same state the composer keeps, so the same components can be fed. */
  const [where, setWhere] = useState<Where>({
    machine: "",
    hostId: like?.hostId ?? "",
    agent: like?.choices.agent ?? "",
  });
  const [accountId, setAccountId] = useState(like?.choices.accountId ?? "");
  const [chosen, setChosen] = useState<Partial<Record<ControlKind, string>>>(() => {
    const was = like?.choices.settings;
    if (!was) return {};
    const seed: Partial<Record<ControlKind, string>> = {};
    (["model", "effort", "mode", "sandbox"] as ControlKind[]).forEach((k) => {
      if (was[k]) seed[k] = was[k]!;
    });
    return seed;
  });
  const [skillIds, setSkillIds] = useState<string[] | null>(like?.choices.skills ?? null);

  const all = useMemo(() => machines(hosts), [hosts]);
  const { host } = useMemo(() => resolve(hosts, where), [hosts, where]);
  const machine =
    all.find((m) => m.key === where.machine) ??
    (host ? all.find((m) => m.hosts.some((h) => h.id === host.id)) : undefined) ??
    all[0];

  // **Which machine the host it names belongs to**, once the list is in.
  // `where.hostId` alone is not enough: `resolve` looks for the host inside
  // the *machine*, and with no machine chosen that is whichever came first —
  // so an edit would draw the right machine only by luck and would save the
  // wrong one.
  const placed = useRef(false);
  useEffect(() => {
    const named = like?.hostId;
    if (placed.current || !named || all.length === 0) return;
    const its = all.find((m) => m.hosts.some((h) => h.id === named));
    if (!its) return;
    placed.current = true;
    setWhere((w) => ({ ...w, machine: its.key, hostId: named }));
  }, [all, like?.hostId]);

  const profile = profiles.find((p) => p.id === profileId);
  const pinned = (profile?.agent ?? undefined) as Agent | undefined;
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

  const controlsQ = useAgentControls(kind ?? "", { query: { enabled: !!kind } });
  const controls = (kind ? (controlsQ.data ?? []) : []) as Control[];

  /* What the pickers open on. See [`unattendedValue`]: `control.current` is
     what that person last worked with, which is the one thing an unattended
     run must not inherit. */
  const valueOf = (c: Control) => chosen[c.kind] ?? unattendedValue(c);
  /** What the sheet is showing for one control, if this engine has it. */
  const showing = (kind: ControlKind) => {
    const c = controls.find((v) => v.kind === kind);
    return c ? valueOf(c) : undefined;
  };

  // A change of engine drops what was chosen for the last one: a model is one
  // agent's, and a mode's word is too.
  //
  // **Only a change.** `kind` is `undefined` until the agent list arrives, so
  // clearing on every run of this wiped what an edit had filled in before
  // anybody saw it.
  const lastKind = useRef<Agent | undefined>(undefined);
  useEffect(() => {
    if (lastKind.current && lastKind.current !== kind) setChosen({});
    lastKind.current = kind;
  }, [kind]);

  // Skills: the set that applies by default — always-on, or a default in a
  // repository this checks out — unless the person picks their own.
  const defaultSkillIds = useMemo(
    () =>
      allSkills
        .filter((s) => s.alwaysOn || s.defaultIn.some((r) => checkouts.some((c) => c.id === r)))
        .map((s) => s.id),
    [allSkills, checkouts],
  );
  const selectedSkills = skillIds ?? defaultSkillIds;

  /* The cadence this opens on: the one it already has when this is an edit,
     the example's when one was picked, and weekdays otherwise. One name for
     all three so each control below reads one thing. */
  const was: Cadence | undefined = like?.triggers[0]?.cadence ?? from?.cadence;
  const [kindOf, setKind] = useState<Cadence["kind"]>(was?.kind ?? "weekdays");
  const [at, setAt] = useState(("at" in (was ?? {}) ? (was as { at: string }).at : "") || "08:30");
  const [day, setDay] = useState<Weekday>(
    was?.kind === "weekly"
      ? was.day
      : was?.kind === "monthly" && was.on.kind === "nth"
        ? was.on.day
        : "monday",
  );
  const [dayOfMonth, setDayOfMonth] = useState(
    was?.kind === "monthly" && was.on.kind === "day" ? was.on.day : 1,
  );
  /**
   * **A month has two ways of saying which day**, and only one of them is a
   * date. "The first Monday" is not a day of the month — cron *ors* the
   * day-of-month field against day-of-week, so the obvious expression means
   * "the first week, or any Monday", which is every Monday. The server
   * compiles the nth-weekday form instead, and the control has to be able to
   * ask for it or an example that says "first Monday" would quietly become
   * the 1st.
   */
  const [monthly, setMonthly] = useState<"day" | "nth">(
    was?.kind === "monthly" ? was.on.kind : "day",
  );
  const [nth, setNth] = useState(
    was?.kind === "monthly" && was.on.kind === "nth" ? was.on.nth : 1,
  );
  const [expr, setExpr] = useState(was?.kind === "custom" ? was.expr : "0 7 * * 1-5");

  /* The schedule's own zone, defaulted to this computer's because that is
     almost always the answer — and stored as the IANA name, never an offset,
     because an offset is wrong twice a year. */
  const [zone, setZone] = useState(
    () =>
      like?.triggers[0]?.timezone ||
      Intl.DateTimeFormat().resolvedOptions().timeZone ||
      "UTC",
  );
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const cadence: Cadence = useMemo(() => {
    switch (kindOf) {
      case "daily":
        return { kind: "daily", at };
      case "weekly":
        return { kind: "weekly", at, day };
      case "monthly":
        return {
          kind: "monthly",
          at,
          on: monthly === "nth" ? { kind: "nth", nth, day } : { kind: "day", day: dayOfMonth },
        };
      case "custom":
        return { kind: "custom", expr };
      default:
        return { kind: "weekdays", at };
    }
  }, [kindOf, at, day, dayOfMonth, expr, monthly, nth]);

  /**
   * **The server reads it back.** No client parses cron: the read-back and
   * the next three fire times come from the one implementation that also
   * advances the clock, so the two cannot disagree about daylight saving in
   * March. The same call is what refuses a cadence under fifteen minutes,
   * which is why the refusal appears under the control that caused it rather
   * than on submit.
   */
  const [reads, setReads] = useState<CadenceAnswer | null>(null);
  useEffect(() => {
    let dropped = false;
    const ask = setTimeout(async () => {
      try {
        const answer = await readCadence({ cadence, timezone: zone });
        if (!dropped) {
          setReads(answer);
          setRefused(null);
        }
      } catch (e) {
        if (!dropped) {
          setReads(null);
          setRefused(e instanceof Error ? e.message : "That is not a cadence Firetower can run.");
        }
      }
    }, 250);
    return () => {
      dropped = true;
      clearTimeout(ask);
    };
  }, [cadence, zone]);

  const norepo = checkouts.length === 0;
  const tooOften = !!refused;
  const close = () => setOpen(null);
  const toggle = (which: string, at: HTMLElement) =>
    setOpen((o) => (o?.which === which ? null : { which, at }));
  const toggleRepo = (r: Checkout) =>
    setCheckouts((list) =>
      list.some((c) => c.id === r.id) ? list.filter((c) => c.id !== r.id) : [...list, r],
    );

  const save = async () => {
    setSaving(true);
    try {
      /* **Created and turned on**, or saved and turned back on. Pressing this
         is the approval — that is what the summary at the foot of the body is
         for — and `createAndTurnOn` carries the argument for why that is two
         calls rather than a flag. `saveEdits` carries the same argument for
         an edit, which un-approves. */
      const body = {
        name,
        prompt,
        repoIds: checkouts.map((c) => c.id),
        hostId: host?.id,
        base: base || undefined,
        cadence,
        timezone: zone,
        profile: profileId || undefined,
        agent: kind,
        accountId: accountId || undefined,
        /* What this engine actually offers, at the value this sheet is
           showing. A control the engine does not have is left out rather
           than sent as null: the server refuses a setting the engine would
           ignore, which is the right answer and a confusing one to get from
           a field nobody filled in. */
        settings: {
          model: showing("model"),
          effort: showing("effort"),
          mode: showing("mode"),
          sandbox: showing("sandbox"),
        },
        /* `null` is "resolve the defaults now and pin them", which is what an
           untouched control means. A set somebody chose is sent as itself. */
        skills: skillIds ?? undefined,
        deleteCleanRuns: deleteClean,
      };
      const made = editing
        ? await saveEdits(editing.id, body, editing.active)
        : await createAndTurnOn(body);
      await client.invalidateQueries({ queryKey: getListSchedulesQueryKey() });
      /* **Only when it should have ended up on.** An edit to a schedule that
         was already switched off leaves it off, which is not news — it is
         where the person left it. */
      if (!made.on && (!editing || editing.active)) {
        /* It exists and it is off. Said here rather than closing on a
           half-done thing: the row is in the library one switch away, and
           somebody who was told nothing would be waiting for a run that is
           never coming. */
        setRefused(
          `“${made.schedule.name}” was ${editing ? "saved" : "created"} but is switched off — ${made.why}. Turn it on from the list when you are ready.`,
        );
        return;
      }
      onClose();
    } catch (e) {
      setRefused(e instanceof Error ? e.message : "Firetower could not write that down.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="veil s-veil scroll-slim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet2 s-sheet" onMouseDown={(e) => e.stopPropagation()}>
        <div className="sh-head">
          <h2>{editing ? "Edit schedule" : "New schedule"}</h2>
          <IconButton of={X} label="Close" onClick={onClose} />
        </div>

        <div className="s-sbody">
          <div className="fld">
            <label htmlFor="sch-name">Name</label>
            <div className="box">
              <input
                id="sch-name"
                value={name}
                placeholder="Dependency audit"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
          </div>

          <div className="fld">
            <label htmlFor="sch-prompt">Prompt</label>
            <div className="s-compose">
              <div className="shelf">
                {/* The composer's own chip and the composer's own menu, which
                    is a multi-select: one working branch across every
                    repository it checks out. */}
                <button
                  onClick={(e) => toggle("repo", e.currentTarget)}
                  data-set={checkouts.length > 0}
                  data-which="repo"
                  className="chip"
                  title="Which repositories each run checks out"
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
                {/* **One machine, named.** It used to say "First available
                    machine" and store no host id — a policy rather than a
                    choice. A schedule names the machine it runs on, the same
                    way starting work does. */}
                <button
                  onClick={(e) => toggle("machine", e.currentTarget)}
                  data-set={!!machine}
                  data-which="machine"
                  className="chip"
                  title={machine ? "Where each run starts" : "No machine to run on"}
                >
                  <span className="grid place-items-center text-mute">
                    <Icon of={machine ? Server : ServerOff} size={14} />
                  </span>
                  <span className="lbl" title={machine ? machineLabel(machine) : undefined}>
                    {machine ? machineLabel(machine) : "No machine"}
                  </span>
                  <Icon of={ChevronDown} size={12} className="text-mute" />
                </button>
              </div>
              <div className="s-in">
                <textarea
                  id="sch-prompt"
                  className="in"
                  rows={5}
                  value={prompt}
                  placeholder="What should the agent do?"
                  onChange={(e) => setPrompt(e.target.value)}
                  /* Enter is a newline. Nothing here submits on a key: this is
                     a paragraph, and the footer is where it is sent. */
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.stopPropagation();
                  }}
                />
                <div className="bar">
                  <button
                    onClick={(e) => toggle("profile", e.currentTarget)}
                    data-set={!!profile}
                    className="chip"
                    title="Which profile the agent wears"
                  >
                    <span className="grid place-items-center text-mute">
                      {pinned ? (
                        <AgentMark agent={pinned} size={15} />
                      ) : (
                        <UserRound className="h-[15px] w-[15px]" strokeWidth={1.8} />
                      )}
                    </span>
                    <span className="lbl">{profile ? profile.name : "Just an agent"}</span>
                    <Icon of={ChevronDown} size={12} className="text-mute" />
                  </button>
                  {/* The engine, the account, the model, the effort, the
                      permissions and the sandbox — one control, the same one
                      the Dashboard and the conversation use. */}
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
                  {/* **A profile resolves the skills or this does, never
                      both**, so with one set there is nothing here to choose
                      between and the chip says who decided instead. */}
                  {profile ? (
                    <span className="chip" title="The profile decides what each run reads.">
                      <span className="grid place-items-center text-mute">
                        <Icon of={Diamond} size={14} />
                      </span>
                      <span className="lbl">Skills set by {profile.name}</span>
                    </span>
                  ) : (
                    <button
                      onClick={(e) => toggle("skills", e.currentTarget)}
                      data-set={selectedSkills.length > 0}
                      className="chip"
                      title="Which skills each run reads"
                    >
                      <span className="grid place-items-center text-mute">
                        <Icon of={Diamond} size={14} />
                      </span>
                      <span className="lbl">
                        {selectedSkills.length === 0
                          ? "No skills"
                          : selectedSkills.length === 1
                            ? (allSkills.find((s) => s.id === selectedSkills[0])?.name ?? "1 skill")
                            : `${selectedSkills.length} skills`}
                      </span>
                      <Icon of={ChevronDown} size={12} className="text-mute" />
                    </button>
                  )}
                </div>
              </div>
            </div>
            <p className="hint">
              Describe the result you expect. The agent cannot ask follow-up questions.
            </p>
          </div>

          <div className="fld">
            <label>Schedule</label>
            <div className="s-trig">
              <span className="s-kind" title="A clock is the only trigger available.">
                On a clock
              </span>
              {/* **The product's pill, not a native select.** Seven of these
                  were `<select>`s — the one control that cannot be made to
                  match anything around it, which is why they leapt out of a
                  row where everything else is ours. `PickOne` draws the same
                  pill and opens the same menu every other picker in the app
                  opens, through `Pop`, so nothing clips it. */}
              <PickOne
                label="How often"
                value={kindOf}
                options={CADENCES.map((c) => ({
                  value: c.kind,
                  label: c.label,
                  // The explanatory half keeps its words and stops being
                  // glued on with an em dash: it is what picking this will
                  // ask for next, and a menu row can draw two lines.
                  note: c.note,
                }))}
                onPick={(v) => setKind(v as Cadence["kind"])}
                width={300}
              />
              {kindOf === "weekly" && (
                <PickOne
                  label="Which day"
                  value={day}
                  options={DAYS.map((d) => ({ value: d, label: titled(d) }))}
                  onPick={(v) => setDay(v as Weekday)}
                />
              )}
              {kindOf === "monthly" && (
                <>
                  <PickOne
                    label="How the day is chosen"
                    value={monthly}
                    options={[
                      { value: "day", label: "on a date" },
                      { value: "nth", label: "on a weekday" },
                    ]}
                    onPick={(v) => setMonthly(v as "day" | "nth")}
                  />
                  {monthly === "day" ? (
                    <PickOne
                      label="Which date"
                      value={String(dayOfMonth)}
                      options={Array.from({ length: 31 }, (_, i) => ({
                        value: String(i + 1),
                        label: String(i + 1),
                      }))}
                      onPick={(v) => setDayOfMonth(Number(v))}
                      width={180}
                    />
                  ) : (
                    <>
                      <PickOne
                        label="Which one"
                        value={String(nth)}
                        options={["first", "second", "third", "fourth", "last"].map((word, i) => ({
                          value: String(i + 1),
                          label: word,
                        }))}
                        onPick={(v) => setNth(Number(v))}
                        width={180}
                      />
                      <PickOne
                        label="Which weekday"
                        value={day}
                        options={DAYS.map((d) => ({ value: d, label: titled(d) }))}
                        onPick={(v) => setDay(v as Weekday)}
                      />
                    </>
                  )}
                </>
              )}
              {kindOf === "custom" ? (
                /* Mono, because a cron expression is read character by
                   character. */
                <input
                  className="s-pill mono"
                  value={expr}
                  onChange={(e) => setExpr(e.target.value)}
                  aria-label="Cron expression"
                  data-bad={tooOften}
                />
              ) : (
                <input
                  className="s-pill mono"
                  type="time"
                  value={at}
                  onChange={(e) => setAt(e.target.value)}
                  aria-label="Time of day"
                />
              )}
              {/* **The one that needed the search.** Several hundred IANA
                  zones: a menu without a filter is a scroll, which is
                  probably why this was left native longest. */}
              <PickOne
                label="Time zone"
                title="The time stays the same through daylight saving changes."
                value={zone}
                options={zones(zone, here).map((z) => ({ value: z, label: z }))}
                onPick={setZone}
                search
                noun="zone"
                width={320}
              />
            </div>

            {refused ? (
              /* **Brick, with a triangle — and deliberately not how a disk
                 refusal is drawn.** This one is correctable where you are
                 standing: the thing to change is six inches above the
                 message. */
              <div className="s-refuse">
                <Icon of={TriangleAlert} size={16} />
                <div>{refused}</div>
              </div>
            ) : (
              <p className="s-reads">
                {reads?.reads ?? "…"}
                {reads && reads.nextFires.length > 0 && (
                  <span className="s-fires">
                    Next three runs: {reads.nextFires.map(fires).join(", ")}.
                  </span>
                )}
                {here && here !== zone && (
                  <span className="s-fires" style={{ color: "var(--color-amber)" }}>
                    This computer is set to {here}. The schedule keeps {zone}, so it runs at that
                    zone&rsquo;s time rather than yours.
                  </span>
                )}
              </p>
            )}
          </div>

          <button className="s-fold" aria-expanded={advanced} onClick={() => setAdvanced((o) => !o)}>
            Advanced
            <Icon of={ChevronDown} size={14} />
          </button>

          {advanced && (
            <div className="s-adv">
              {/* **No base branch without a repository**: there is nothing to
                  branch from, and a picker offering `main` would be a control
                  the server has nothing to apply. */}
              {!norepo && (
                <div className="s-arow">
                  <span className="s-al">
                    <b>Base branch</b>
                    <s>Each run branches from here, in every repository it checks out.</s>
                  </span>
                  <span className="s-av">
                    <input
                      className="s-pill mono"
                      value={base}
                      placeholder="main"
                      onChange={(e) => setBase(e.target.value)}
                      aria-label="Base branch"
                    />
                  </span>
                </div>
              )}

              {/* **No switch without a repository**, and the row stays with a
                  read-only line in its place. `session_work` answers an empty
                  list for a workspace with nothing checked out, so "nothing
                  uncommitted" is vacuously true and a clean-run rule would
                  read a bare workspace as the safe case — `ui/end.ts` already
                  learned this and calls it "the dangerous case, not the safe
                  one", because git never saw the directory, so every file the
                  agent made goes with it. The desktop asks about that
                  separately; a timer cannot ask, so it must not offer. */}
              <div className="s-arow">
                <span className="s-al">
                  <b>Delete the workspace after a clean run</b>
                  <s>
                    {norepo
                      ? "Not available without a repository. Nothing is checked out, so there is no way to tell what a run left behind."
                      : "A run that failed, needed you, or left work uncommitted keeps its workspace either way."}
                  </s>
                </span>
                <span className="s-av">
                  {norepo ? (
                    <span className="s-src">
                      Everything is <b>kept</b>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="tog"
                      role="switch"
                      aria-checked={deleteClean}
                      aria-label="Delete the workspace after a clean run"
                      title={deleteClean ? "Keep every workspace instead" : "Delete clean runs again"}
                      onClick={() => setDeleteClean((o) => !o)}
                    >
                      <i />
                    </button>
                  )}
                </span>
              </div>
            </div>
          )}

          {/* **No consequence summary here, and the reason is which screen
              this is.** Every row of it either restated a control six inches
              above — the repositories, the machine, the engine, the account —
              or was boilerplate true of every schedule ever made. The same
              fact in a control, a label and a summary is what the copy
              standard's rule 5 is about, and the controls are the disclosure.

              **The proposal review keeps its copy of it**, and that is not an
              inconsistency: there, an agent chose those things and you are
              approving somebody else's configuration, so the summary is the
              only place the effective authority is stated. */}
        </div>

        <div className="sh-foot">
          <span className="where">
            {all.length === 0
              ? "No machine to run on yet."
              : editing
                ? editing.active
                  ? "Saving this approves what it says now."
                  : "It stays switched off until you turn it on."
                : "An agent can propose a schedule for you to approve."}
          </span>
          <button className="btn quiet" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={saving || tooOften || !name.trim() || !prompt.trim() || !host}
            title={host ? undefined : "Pick a machine for it to run on"}
            onClick={save}
          >
            {editing ? "Save changes" : "Create schedule"}
          </button>
        </div>
      </div>

      {/* ---------- the composer's menus, dropped from this sheet's chips ---------- */}
      {open?.which === "repo" && (
        <Pop anchor={open.at} onClose={close} width={340}>
          <RepoMenu repos={repos} checkouts={checkouts} onToggle={toggleRepo} onClose={close} />
        </Pop>
      )}

      {open?.which === "machine" && (
        <Pop anchor={open.at} onClose={close} width={340}>
          <Menu>
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
          {/* Outside the scroller, for the same reason it is on the composer:
              it is what the machine you picked is up to, not another machine
              to pick. */}
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

      {open?.which === "profile" && (
        <Pop anchor={open.at} onClose={close} width={320}>
          <ProfileMenu
            profiles={profiles}
            profileId={profileId}
            onPick={(id) => {
              setProfileId(id);
              close();
            }}
          />
        </Pop>
      )}

      {open?.which === "skills" && (
        <Pop anchor={open.at} onClose={close} width={340}>
          <Menu>
            <Head>Skills each run reads</Head>
            {allSkills.length === 0 && (
              <div className="px-3 py-3 text-center text-micro text-mute">
                Your library has no skills yet.
              </div>
            )}
            {allSkills.map((s) => {
              const on = selectedSkills.includes(s.id);
              return (
                <Opt
                  key={s.id}
                  on={on}
                  keepOpen
                  onPick={() =>
                    setSkillIds(
                      on
                        ? selectedSkills.filter((x) => x !== s.id)
                        : [...selectedSkills, s.id],
                    )
                  }
                  icon={<Diamond className="h-4 w-4" strokeWidth={1.75} />}
                  title={s.name}
                  sub={s.alwaysOn ? "always on" : (s.description || undefined)}
                />
              );
            })}
          </Menu>
          <div className="pkfoot">
            Resolved and pinned when you create it, so a run reads the versions you approved.
          </div>
        </Pop>
      )}
    </div>
  );
}

/**
 * The zones to offer.
 *
 * The whole IANA list where the browser will give it, and otherwise the two
 * that matter — the one chosen and the one this computer is in — so the
 * control is never empty.
 */
function zones(chosen: string, here: string): string[] {
  const all =
    typeof Intl.supportedValuesOf === "function" ? (Intl.supportedValuesOf("timeZone") as string[]) : [];
  if (all.length > 0) return all;
  return Array.from(new Set([chosen, here, "UTC"].filter(Boolean)));
}

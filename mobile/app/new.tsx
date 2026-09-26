/**
 * Starting work.
 *
 * A workspace is a checkout on a machine with agents in it, so the form has to
 * ask for all three — and the contract is `NewSession`, not what seems like
 * enough. A form asking for a name, one repository and a first message is a
 * plausible-looking form that cannot express half of what a workspace is:
 * several repositories cut at different bases, which machine, whose
 * subscription, and how it competes for that machine when other agents are
 * already on it.
 *
 * The layout is this client's own; the fields, their meaning and the payload
 * are the web build's, because there is one control plane and it has one idea
 * of what starting work means.
 *
 * ## No prompt is sent, ever
 *
 * Including from a task. The agent starts and waits; what you want doing is
 * said in the conversation, where it can be answered. A task seeds the
 * composer instead, unsent. That rule is the whole reason this form has no
 * "what should it do" box, and it is not an omission.
 *
 * ## What the phone changes
 *
 * Six fields do not fit on 390pt, and a wizard would hide the one thing people
 * change most (the repository) behind three taps. So it is one scrolling form
 * with the pickers as panels, and the action pinned to the foot — the same
 * decision as the Commit tab, for the same reason.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { router } from "expo-router";
import * as Haptics from "expo-haptics";
import { GitBranch, Plus, X } from "lucide-react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCreateSession } from "~/api/generated/sessions/sessions";
import type { Agent, Share } from "~/api/generated/model";
import { useAccounts, useAgents, useHosts, useRepos, why } from "~/data";
import { leaveDraft } from "~/workspace/draft";
import { takeConnected } from "~/workspace/connected";
import { Field, Picker, Trigger, type Choice } from "~/ui/Picker";
import { Segmented } from "~/ui/Segmented";
import { color, size } from "~/design/tokens.generated";

/** `auth refactor` → `agent/auth-refactor`, the way the web build suggests one. */
const slug = (name: string) =>
  name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const SHARES: [Share, string][] = [
  ["yields", "Yields"],
  ["equal", "Equal"],
  ["takesMore", "Takes more"],
];
const SAYS: Record<Share, string> = {
  yields: "Waits for the others.",
  equal: "Takes its turn.",
  takesMore: "Goes first.",
};

type Open = null | "repo" | "host" | "agent" | "account";

export default function NewWorkspace() {
  const insets = useSafeAreaInsets();
  const nav = useRouter();

  /**
   * Started from a task, when it was.
   *
   * The title seeds the name, the repository is preselected when this server
   * has it, and the task's key and address ride along so the workspace knows
   * what it is for. What the task *says* does not become a prompt — see
   * `leaveDraft` below.
   */
  const seed = useLocalSearchParams<{
    title?: string;
    repo?: string;
    body?: string;
    taskKey?: string;
    taskUrl?: string;
  }>();

  /* Everything offered here is what this server actually has. A form that
     lists agents from a constant is a form that offers one somebody removed.

     The loading half is kept rather than dropped: each of these is a list
     that arrives over the network, and a panel that draws nothing while it is
     still in flight says *there are none of these* — which for repositories
     is the one answer that sends somebody looking for a laptop. */
  const { data: repos, loading: findingRepos } = useRepos();
  const { data: hosts, loading: findingHosts } = useHosts();
  const { data: agents, loading: findingAgents } = useAgents();
  const { data: accounts, loading: findingAccounts } = useAccounts();
  const create = useCreateSession();
  const [wrong, setWrong] = useState<string | null>(null);

  const [name, setName] = useState(seed.title ?? "");
  const [picked, setPicked] = useState<string[]>([]);
  /* Preselect the task's repository once the list has arrived, and only while
     nobody has chosen for themselves. */
  useEffect(() => {
    if (!seed.repo || picked.length > 0) return;
    const match = repos.find((r) => r.slug === seed.repo);
    if (match) setPicked([match.id]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repos.length, seed.repo]);
  /**
   * Whatever was just connected on `/repos`, chosen here.
   *
   * The repository is the reason anybody leaves this form for that screen, so
   * coming back with it unchosen would mean opening the picker again to find a
   * row created ten seconds ago. Taken on focus and taken once — see
   * `workspace/connected.ts`.
   */
  useFocusEffect(
    useCallback(() => {
      const made = takeConnected();
      if (made.length === 0) return;
      setPicked((was) => [...was, ...made.filter((id) => !was.includes(id))]);
    }, []),
  );

  const [branch, setBranch] = useState("");
  const [touched, setTouched] = useState(false);
  const [hostId, setHostId] = useState("");
  const [agent, setAgent] = useState("");
  const [accountId, setAccountId] = useState("");
  const [share, setShare] = useState<Share>("equal");
  const [open, setOpen] = useState<Open>(null);

  /* The branch follows the name until somebody edits it, and then it stops —
     a field that keeps overwriting what you typed is worse than one that never
     helped. */
  const suggested = name.trim() ? `agent/${slug(name)}` : "";
  const branchValue = touched ? branch : suggested;

  const host = hosts.find((h) => h.id === hostId);
  const account = accounts.find((a) => a.id === accountId);
  const chosenRepos = repos.filter((r) => picked.includes(r.id));

  /* Only accounts for the agent that will run. Offering a Codex login to a
     Claude Code session is a choice that cannot work. */
  const forAgent: Choice[] = useMemo(
    () =>
      accounts
        /* Only accounts for the agent that will run. Offering a Codex login to
           a Claude Code session is a choice that cannot work. */
        .filter((a) => !agent || a.kind === agent)
        .map((a) => ({
          id: a.id,
          label: a.name,
          detail: a.identity ?? (a.isDefault ? "default" : undefined),
          blocked: a.credentialSet ? undefined : "No credential set",
        })),
    [agent, accounts],
  );

  const ready = name.trim().length > 0 && picked.length > 0 && !!hostId && !!agent && !create.isPending;

  return (
    <View className="flex-1 bg-ground" style={{ paddingTop: insets.top }}>
      <View className="flex-row items-center justify-between px-2 pb-2 pt-1">
        <Pressable
          onPress={() => router.back()}
          className="h-10 w-10 items-center justify-center"
          hitSlop={8}
        >
          <X color={color.dim} size={20} />
        </Pressable>
        <Text className="font-medium text-title text-bone">New workspace</Text>
        <View className="h-10 w-10" />
      </View>

      <ScrollView
        contentContainerStyle={{ gap: 20, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 32 }}
        keyboardShouldPersistTaps="handled"
      >
        <Field label="Name" hint="What this branch is for">
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="auth refactor"
            placeholderTextColor={color.mute}
            selectionColor={color.ember}
            autoCapitalize="none"
            className="rounded-xl border border-line bg-ground px-3.5 py-3 font-sans text-bone"
            style={{ fontSize: size.ui, minHeight: 48 }}
          />
        </Field>

        <Field label="Repositories" hint="One or more">
          <View className="gap-2">
            {chosenRepos.map((r) => (
              <View
                key={r.id}
                className="flex-row items-center gap-2 rounded-xl border border-line bg-panel px-3.5 py-3"
              >
                <View className="min-w-0 flex-1">
                  <Text numberOfLines={1} className="font-mono text-ui text-bone">
                    {r.slug}
                  </Text>
                  <View className="mt-0.5 flex-row items-center gap-1.5">
                    <GitBranch color={color.mute} size={11} />
                    <Text numberOfLines={1} className="font-mono text-meta text-mute">
                    {r.remote}
                  </Text>
                  </View>
                </View>
                <Pressable onPress={() => setPicked(picked.filter((x) => x !== r.id))} hitSlop={8}>
                  <X color={color.mute} size={15} />
                </Pressable>
              </View>
            ))}
            <Pressable
              onPress={() => setOpen("repo")}
              style={{ minHeight: 48 }}
              className="flex-row items-center gap-2 rounded-xl border border-dashed border-line px-3.5 py-3"
            >
              <Plus color={color.dim} size={15} />
              <Text className="font-sans text-ui text-dim">
                {picked.length ? "Add another" : "Choose a repository"}
              </Text>
            </Pressable>
          </View>
        </Field>

        <Field label="Branch" hint="Cut from the base above">
          <TextInput
            value={branchValue}
            onChangeText={(v) => {
              setTouched(true);
              setBranch(v);
            }}
            placeholder="agent/…"
            placeholderTextColor={color.mute}
            selectionColor={color.ember}
            autoCapitalize="none"
            autoCorrect={false}
            className="rounded-xl border border-line bg-ground px-3.5 py-3 text-bone"
            style={{ fontSize: size.ui, fontFamily: "JetBrainsMono_400Regular", minHeight: 48 }}
          />
        </Field>

        <Field label="Where it runs">
          <View className="gap-2">
            <Trigger
              value={host ? `${host.name} · ${host.cpus ?? "?"} vCPU` : undefined}
              placeholder="Choose a machine"
              onPress={() => setOpen("host")}
            />
            <Trigger
              value={agents.find((a) => a.kind === agent)?.label}
              placeholder="Choose an agent"
              onPress={() => setOpen("agent")}
            />
          </View>
        </Field>

        <Field label="Account" hint="Whose subscription this runs on">
          <Trigger
            value={account?.name}
            placeholder={agent ? "Choose an account" : "Pick an agent first"}
            onPress={() => agent && setOpen("account")}
          />
        </Field>

        <Field label="When the machine is busy">
          <View className="gap-2">
            <Segmented options={SHARES} value={share} onChange={setShare} />
            <Text className="font-sans text-meta text-mute">{SAYS[share]}</Text>
          </View>
        </Field>

        {/* Said plainly, because it is the one thing about this form that
            surprises people who have used anything else. */}
        <View className="rounded-xl border border-line bg-panel px-4 py-3.5">
          <Text className="font-sans text-meta text-dim">
            The agent starts and waits. What you want doing is said in the conversation, where it
            can be answered.
          </Text>
        </View>
      </ScrollView>

      <KeyboardStickyView offset={{ closed: 0, opened: 0 }}>
        <View
          className="border-t border-line-soft bg-ground px-4 pt-3"
          style={{ paddingBottom: Math.max(insets.bottom, 10) }}
        >
          {wrong ? (
            <Text className="mb-2 text-center font-sans text-meta text-brick">{wrong}</Text>
          ) : null}
          <Pressable
            disabled={!ready}
            onPress={async () => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              setWrong(null);
              try {
                const made = await create.mutateAsync({
                  data: {
                    name: name.trim(),
                    branch: branchValue,
                    repos: picked.map((repoId) => ({ repoId })),
                    hostId,
                    agent: agent as Agent,
                    accountId: accountId || undefined,
                    share,
                    taskKey: seed.taskKey,
                    taskUrl: seed.taskUrl,
                    // Never a prompt. See the note at the top of this file.
                  },
                });
                /* The task's text goes into the composer, unsent. The agent
                   starts working when a person decides it should. */
                if (seed.taskKey || seed.body) {
                  const lines = [seed.taskUrl, seed.body].filter(Boolean).join("\n\n");
                  if (lines) leaveDraft(made.id, lines);
                }
                nav.replace(`/workspace/${made.workspaceId ?? made.id}`);
              } catch (e) {
                setWrong(why(e));
              }
            }}
            style={{ height: 52 }}
            className={`items-center justify-center rounded-xl ${ready ? "bg-bone" : "bg-overlay"}`}
          >
            {create.isPending ? (
              <ActivityIndicator color={color.mute} />
            ) : (
              <Text className={`font-semibold text-title ${ready ? "text-ground" : "text-mute"}`}>
                Start the workspace
              </Text>
            )}
          </Pressable>
        </View>
      </KeyboardStickyView>

      <Picker
        open={open === "repo"}
        title="Repositories"
        waiting={findingRepos ? "Reading your repositories" : undefined}
        empty="No repository is connected to this Firetower yet."
        chosen={picked}
        choices={repos.map((r) => ({ id: r.id, label: r.slug, detail: r.remote }))}
        onPick={(id) => setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id])}
        onClose={() => setOpen(null)}
        /* The one thing this list cannot hold: a repository nobody has
           connected yet. Everything else offered on this form is administered
           from a desk, but a repository is what the work is *in* — and until
           this existed, somebody whose repository was not on the server had
           nowhere to go from here. */
        action={{
          label: "Connect a repository",
          onPress: () => {
            setOpen(null);
            router.push({ pathname: "/repos", params: { pick: "1" } });
          },
        }}
      />
      <Picker
        open={open === "host"}
        title="Where it runs"
        waiting={findingHosts ? "Reading the machines" : undefined}
        empty="No machine is connected to this Firetower yet. They are added from the desktop or the web console."
        chosen={hostId}
        choices={hosts.map((h) => ({
          id: h.id,
          label: h.name,
          detail: `${h.cpus} vCPU · worker ${h.workerVersion ?? "—"}`,
          /* Dimmed and unchoosable, with the reason. A machine the scheduler
             cannot reach has not failed; it is not there. */
          blocked: h.state === "Online" ? undefined : `${h.state} — ${h.diagnosis ?? "not answering"}`,
        }))}
        onPick={(id) => {
          setHostId(id);
          setOpen(null);
        }}
        onClose={() => setOpen(null)}
      />
      <Picker
        open={open === "agent"}
        title="Agent"
        waiting={findingAgents ? "Reading the agents" : undefined}
        empty="No agent is installed on this Firetower yet."
        chosen={agent}
        choices={agents.map((a) => ({
          id: a.kind,
          label: a.label,
          detail: a.hosts?.[0]?.version ?? undefined,
          blocked: a.supported ? undefined : "Not supported on this server",
        }))}
        onPick={(id) => {
          setAgent(id);
          // The account belonged to the old agent; it cannot belong to this one.
          setAccountId("");
          setOpen(null);
        }}
        onClose={() => setOpen(null)}
      />
      <Picker
        open={open === "account"}
        title="Account"
        waiting={findingAccounts ? "Reading the accounts" : undefined}
        empty="No account for this agent. One is added from the desktop or the web console."
        chosen={accountId}
        choices={forAgent}
        onPick={(id) => {
          setAccountId(id);
          setOpen(null);
        }}
        onClose={() => setOpen(null)}
      />
    </View>
  );
}

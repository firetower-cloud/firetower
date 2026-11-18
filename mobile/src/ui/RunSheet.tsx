/**
 * How it runs: the engine, whose subscription it spends, and its model,
 * effort and permissions.
 *
 * The phone's `RunPicker`. The desk nests its panes inside one popover; a
 * phone has no popover, so this is a sheet of rows and each row opens a
 * `Picker` over it. **Choosing returns to the sheet rather than dismissing
 * both**, because somebody changing a model often changes the effort too.
 *
 * The pickers are `new.tsx`'s, lifted rather than rewritten: the same blocked
 * reasons, the same *what is being read* and *there are none* sentences, and
 * the same `caution` passed straight through so a choice that grants stays
 * drawn apart. A list where "ask me first" and "never ask me again" look
 * identical is the one place in a picker where getting it wrong costs
 * something.
 *
 * ## The `Picker` is a child of the sheet, not a sibling of it
 *
 * Both are `Modal`s. A modal presents from the nearest enclosing one, so a
 * picker rendered *inside* the sheet comes up over it and leaves it standing;
 * rendered beside it, it would be a second presentation from a root that is
 * already presenting. That is also what makes "returns to the sheet" free —
 * the sheet never closed.
 *
 * ## A pinned engine does not collapse the pick
 *
 * When the profile names an engine, the Agent row becomes a quiet line saying
 * so — the desk's own string — and the account and the controls stay exactly
 * where they were. Collapsing the whole pick would hide the account behind
 * nothing, and the account is the one thing in here that can stop a session
 * starting.
 *
 * ## The account row is drawn even when there are none
 *
 * The desk hides it, because the notice above its composer already names the
 * missing account and offers to connect one. There is nothing to connect from
 * a phone, so the row stays and its picker says where an account is added —
 * which is the only useful thing this client can say about it.
 */
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { ChevronRight } from "lucide-react-native";
import type { Account, AgentView, Control, ControlKind, Host } from "~/api/generated/model";
import { AgentMark } from "~/ui/AgentMark";
import { Picker, type Choice } from "~/ui/Picker";
import { Sheet } from "~/ui/Sheet";
import { useTheme } from "~/design/theme";
import { size } from "~/design/tokens.generated";

type Pane = null | "agent" | "account" | ControlKind;

/** One row: what it changes on the left, what is in force on the right. */
function Row({
  label,
  value,
  first,
  onPress,
}: {
  label: string;
  value?: string;
  first?: boolean;
  onPress: () => void;
}) {
  const { color } = useTheme();
  return (
    <Pressable
      testID={`run-row-${label}`}
      onPress={onPress}
      className={`min-h-[56px] flex-row items-center gap-3 px-5 py-2.5 ${
        first ? "" : "border-t border-line-soft"
      }`}
      android_ripple={{ color: color.overlay }}
    >
      <Text numberOfLines={1} className="min-w-0 flex-1 font-sans text-dim" style={{ fontSize: size.ui }}>
        {label}
      </Text>
      <Text numberOfLines={1} className="shrink font-sans text-bone" style={{ fontSize: size.ui }}>
        {value ?? "—"}
      </Text>
      <ChevronRight color={color.mute} size={15} />
    </Pressable>
  );
}

export function RunSheet({
  agent,
  agents,
  host,
  accounts,
  accountId,
  locked,
  controls,
  valueOf,
  findingAgents,
  findingAccounts,
  onPickAgent,
  onPickAccount,
  onPickControl,
  onClose,
}: {
  /** What will run. Null when this server has no agent it can start. */
  agent: AgentView | null;
  agents: AgentView[];
  /** Which machine, because every blocked reason in the agent list is about it. */
  host: Host | null;
  /** Every account, not only the usable ones: the rest are shown with a reason. */
  accounts: Account[];
  accountId: string;
  /** The profile pinned the engine; it is shown, not chosen. */
  locked: boolean;
  controls: Control[];
  valueOf: (c: Control) => string | undefined;
  findingAgents?: boolean;
  findingAccounts?: boolean;
  onPickAgent: (kind: string) => void;
  onPickAccount: (id: string) => void;
  onPickControl: (kind: ControlKind, value: string) => void;
  onClose: () => void;
}) {
  const { color } = useTheme();
  const [pane, setPane] = useState<Pane>(null);

  const inForce = (c: Control): string | undefined => {
    const value = valueOf(c);
    return c.choices.find((k) => k.value === value)?.label;
  };

  /* Only accounts for the agent that will run. Offering a Codex login to a
     Claude Code session is a choice that cannot work. */
  const forAgent: Choice[] = accounts
    .filter((a) => !agent || a.kind === agent.kind)
    .map((a) => ({
      id: a.id,
      label: a.name,
      detail: a.identity ?? (a.isDefault ? "default" : undefined),
      blocked: !a.enabled
        ? "Account disabled"
        : a.state !== "connected" || !a.credentialSet
          ? "Account not connected"
          : undefined,
    }));

  const account = accounts.find((a) => a.id === accountId);

  return (
    <Sheet open onClose={onClose} maxHeight="86%">
      <Text className="px-5 pb-2 pt-1 font-narrow text-micro uppercase tracking-[0.18em] text-mute">
        How it runs
      </Text>

      <ScrollView keyboardShouldPersistTaps="handled">
        {locked ? (
          /* Not a row and not tappable: the profile decided this, and a
             control that looks like one and refuses is worse than a
             sentence. The desk's string, to the character. */
          <View className="min-h-[56px] flex-row items-center gap-2.5 px-5 py-3.5">
            {agent ? <AgentMark agent={agent.kind} size={15} tone={color.mute} /> : null}
            <Text numberOfLines={1} className="min-w-0 flex-1 font-sans text-meta text-mute">
              {agent?.label ?? "—"} · set by the profile
            </Text>
          </View>
        ) : (
          <Row label="Agent" value={agent?.label} first onPress={() => setPane("agent")} />
        )}
        <Row label="Account" value={account?.name} onPress={() => setPane("account")} />
        {controls.map((c) => (
          <Row key={c.kind} label={c.fallback} value={inForce(c)} onPress={() => setPane(c.kind)} />
        ))}
      </ScrollView>

      {/* Inside the sheet, so each one presents over it and leaves it up. */}
      <Picker
        open={pane === "agent"}
        title="Agent"
        waiting={findingAgents ? "Reading the agents" : undefined}
        empty="No agent is installed on this Firetower yet."
        chosen={agent?.kind}
        choices={agents.map((a) => {
          const onHost = a.hosts.find((h) => h.hostId === host?.id);
          return {
            id: a.kind,
            label: a.label,
            detail: onHost?.version ?? undefined,
            blocked: !a.supported
              ? "Not supported on this server"
              : !host
                ? "No machine is online"
                : !onHost?.installed
                  ? `Not installed on ${host.name}`
                  : undefined,
          };
        })}
        onPick={(kind) => {
          onPickAgent(kind);
          setPane(null);
        }}
        onClose={() => setPane(null)}
      />
      <Picker
        open={pane === "account"}
        title="Account"
        waiting={findingAccounts ? "Reading the accounts" : undefined}
        empty="No account for this agent. One is added from the desktop or the web console."
        chosen={accountId}
        choices={forAgent}
        onPick={(id) => {
          onPickAccount(id);
          setPane(null);
        }}
        onClose={() => setPane(null)}
      />
      {controls.map((c) => (
        <Picker
          key={c.kind}
          open={pane === c.kind}
          title={c.fallback}
          chosen={valueOf(c)}
          choices={c.choices.map((k) => ({
            id: k.value,
            label: k.label,
            detail: k.note ?? undefined,
            caution: k.caution,
          }))}
          onPick={(value) => {
            onPickControl(c.kind, value);
            setPane(null);
          }}
          onClose={() => setPane(null)}
        />
      ))}
    </Sheet>
  );
}

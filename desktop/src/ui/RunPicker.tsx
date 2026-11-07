/**
 * What runs this, in one control: the agent, its account, and its model,
 * effort and permissions.
 *
 * The conversation's `AgentPicker` keeps the agent fixed — a running session
 * cannot change what it is. Starting one can, so this is that picker with two
 * panes in front: pick the engine and whose account it runs on, then the same
 * model / effort / permissions beneath. Same shape, same menu, so there is one
 * thing to learn and it reads the same in both places.
 */
import { useEffect, useState } from "react";
import { Check, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { AgentMark } from "~/components/AgentMark";
import type { Agent, Choice, Control, ControlKind } from "~/api/generated/model";

type AgentOpt = { kind: Agent; label: string };
type AcctOpt = { id: string; name: string; isDefault?: boolean };
type Pane = "agent" | "account" | ControlKind | null;

export function RunPicker({
  agent,
  agentLabel,
  agents,
  accounts,
  accountId,
  agentLocked,
  controls,
  valueOf,
  onPickAgent,
  onPickAccount,
  onPickControl,
}: {
  agent: Agent;
  agentLabel?: string;
  agents: AgentOpt[];
  accounts: AcctOpt[];
  accountId: string;
  /** The profile pinned the engine; it is shown, not chosen. */
  agentLocked?: boolean;
  controls: Control[];
  valueOf: (c: Control) => string | undefined;
  onPickAgent: (kind: Agent) => void;
  onPickAccount: (id: string) => void;
  onPickControl: (kind: ControlKind, value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pane, setPane] = useState<Pane>(null);

  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (pane) setPane(null);
      else setOpen(false);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [open, pane]);

  const shut = () => {
    setOpen(false);
    setPane(null);
  };

  const inForce = (kind: ControlKind): Choice | undefined => {
    const control = controls.find((c) => c.kind === kind);
    if (!control) return undefined;
    const value = valueOf(control);
    return control.choices.find((c) => c.value === value);
  };

  const name = agentLabel ?? agent;
  const model = inForce("model");
  const effort = inForce("effort");
  const account = accounts.find((a) => a.id === accountId);

  return (
    <div className="relative">
      <button
        onClick={() => (open ? shut() : setOpen(true))}
        title={`${name}${model ? ` · ${model.label}` : ""}${effort ? ` · ${effort.label}` : ""}`}
        className="control max-w-[22rem] shrink-0 overflow-hidden text-mute hover:bg-raise hover:text-bone"
      >
        <AgentMark agent={agent} size={12} className="shrink-0" />
        <span className="truncate">{model ? model.label : name}</span>
        {effort && <span className="shrink-0 truncate text-dim">· {effort.label}</span>}
        <ChevronDown className="h-3 w-3 shrink-0" strokeWidth={2} />
      </button>

      {open && (
        <>
          <button className="catcher z-20" onClick={shut} />
          <div className="scroll-slim absolute bottom-full left-0 z-30 mb-1.5 max-h-[min(26rem,60vh)] w-[18rem] overflow-y-auto overflow-x-hidden rounded-lg border border-line bg-overlay p-1 shadow-(--shadow-float)">
            {pane === null ? (
              <>
                {agentLocked ? (
                  <div className="flex items-center gap-2 px-2.5 pt-1.5 pb-2">
                    <AgentMark agent={agent} size={11} className="shrink-0 text-mute" />
                    <span className="truncate text-meta text-mute">{name} · set by the profile</span>
                  </div>
                ) : (
                  <Row label="Agent" value={name} onOpen={() => setPane("agent")} />
                )}
                {accounts.length > 0 && (
                  <Row label="Account" value={account?.name} onOpen={() => setPane("account")} />
                )}
                {controls.map((c) => (
                  <Row
                    key={c.kind}
                    label={c.fallback}
                    value={inForce(c.kind)?.label}
                    onOpen={() => setPane(c.kind)}
                  />
                ))}
              </>
            ) : pane === "agent" ? (
              <div>
                <Back label="Agent" onBack={() => setPane(null)} />
                {agents.map((a) => (
                  <AgentOption
                    key={a.kind}
                    agent={a.kind}
                    label={a.label}
                    chosen={a.kind === agent}
                    onPick={() => {
                      onPickAgent(a.kind);
                      setPane(null);
                    }}
                  />
                ))}
              </div>
            ) : pane === "account" ? (
              <div>
                <Back label="Account" onBack={() => setPane(null)} />
                {accounts.map((a) => (
                  <Option
                    key={a.id}
                    label={a.name}
                    note={a.isDefault ? "default" : undefined}
                    chosen={a.id === accountId}
                    onPick={() => {
                      onPickAccount(a.id);
                      setPane(null);
                    }}
                  />
                ))}
              </div>
            ) : (
              controls
                .filter((c) => c.kind === pane)
                .map((control) => (
                  <div key={control.kind}>
                    <Back label={control.fallback} onBack={() => setPane(null)} />
                    {control.choices.map((c) => (
                      <Option
                        key={c.value}
                        label={c.label}
                        note={c.note ?? undefined}
                        chosen={c.value === valueOf(control)}
                        onPick={() => {
                          onPickControl(control.kind, c.value);
                          setPane(null);
                        }}
                      />
                    ))}
                  </div>
                ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Row({ label, value, onOpen }: { label: string; value?: string; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-raise"
    >
      <span className="min-w-0 flex-1 truncate text-ui text-bone">{label}</span>
      <span className="min-w-0 shrink truncate text-ui text-mute">{value ?? ""}</span>
      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-mute" strokeWidth={2} />
    </button>
  );
}

function Option({
  label,
  note,
  chosen,
  onPick,
}: {
  label: string;
  note?: string;
  chosen: boolean;
  onPick: () => void;
}) {
  return (
    <button
      onClick={onPick}
      className="flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-raise"
    >
      <Check
        className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${chosen ? "text-bone" : "text-transparent"}`}
        strokeWidth={2}
      />
      <span className="min-w-0">
        <span className="block truncate text-ui text-bone">{label}</span>
        {note && <span className="block text-meta text-mute">{note}</span>}
      </span>
    </button>
  );
}

function AgentOption({
  agent,
  label,
  chosen,
  onPick,
}: {
  agent: Agent;
  label: string;
  chosen: boolean;
  onPick: () => void;
}) {
  return (
    <button
      onClick={onPick}
      className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-raise"
    >
      <Check
        className={`h-3.5 w-3.5 shrink-0 ${chosen ? "text-bone" : "text-transparent"}`}
        strokeWidth={2}
      />
      <AgentMark agent={agent} size={15} className="shrink-0 text-dim" />
      <span className="min-w-0 flex-1 truncate text-ui text-bone">{label}</span>
    </button>
  );
}

function Back({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <button
      onClick={onBack}
      className="flex w-full items-center gap-1.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-raise"
    >
      <ChevronLeft className="h-3.5 w-3.5 shrink-0 text-mute" strokeWidth={2} />
      <span className="text-meta text-mute">{label}</span>
    </button>
  );
}

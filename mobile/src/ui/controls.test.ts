/**
 * What a picker shows, and what tapping one should do.
 *
 * The renderer needs `react-native`, which is stubbed here, so what can be
 * checked is the decision the composer makes before it draws anything. Each
 * case below is a way the two kinds of agent differ: Claude and Codex take a
 * setting on the next turn, Kimi applies it by RPC and may refuse.
 */
import { describe, expect, it } from "vitest";
import { planPick, shownValue } from "./controls";

const model = { kind: "model" as const, current: "kimi-k2" };

describe("what an ACP picker shows", () => {
  it("shows what the agent confirmed, not what was just tapped", () => {
    // The tap is recorded the same way for either agent; only ACP ignores it.
    const shown = shownValue({ acp: true, control: model, chosen: { model: "kimi-k2-thinking" } });
    expect(shown).toBe("kimi-k2");
  });

  it("keeps the old value while a refusal is still possible", () => {
    // Nothing has come back yet, so the picker must not have moved.
    const before = shownValue({ acp: true, control: model, chosen: {} });
    const during = shownValue({ acp: true, control: model, chosen: { model: "kimi-k2-thinking" } });
    expect(during).toBe(before);
  });

  it("moves only once the agent reports the new value", () => {
    const after = shownValue({
      acp: true,
      control: { kind: "model", current: "kimi-k2-thinking" },
      chosen: { model: "kimi-k2-thinking" },
    });
    expect(after).toBe("kimi-k2-thinking");
  });

  it("never falls back to the tapped value when the agent has said nothing", () => {
    const shown = shownValue({
      acp: true,
      control: { kind: "model", current: null },
      chosen: { model: "kimi-k2-thinking" },
      model: "from the conversation",
    });
    expect(shown).toBe("from the conversation");
    expect(shown).not.toBe("kimi-k2-thinking");
  });
});

describe("what a Claude or Codex picker shows", () => {
  it("moves the moment it is tapped, because the next turn will take it", () => {
    const shown = shownValue({ acp: false, control: model, chosen: { model: "opus" } });
    expect(shown).toBe("opus");
  });

  it("falls back to what the agent reported when nothing was tapped", () => {
    expect(shownValue({ acp: false, control: model, chosen: {} })).toBe("kimi-k2");
  });
});

describe("what either picker falls back to", () => {
  it("uses the conversation's model for a control with no value yet", () => {
    const shown = shownValue({
      acp: false,
      control: { kind: "model", current: null },
      chosen: {},
      model: "sonnet",
    });
    expect(shown).toBe("sonnet");
  });

  it("uses the conversation's mode for the mode control", () => {
    const shown = shownValue({
      acp: false,
      control: { kind: "mode", current: null },
      chosen: {},
      mode: "acceptEdits",
    });
    expect(shown).toBe("acceptEdits");
  });

  it("has nothing to show for a control nobody has spoken for", () => {
    const shown = shownValue({ acp: true, control: { kind: "effort", current: null }, chosen: {} });
    expect(shown).toBeUndefined();
  });
});

describe("what tapping a choice does", () => {
  it("is ignored while a change is still in flight", () => {
    // The worker refuses a second configuration while the first is
    // outstanding, so offering one here would only desynchronise the label.
    expect(planPick({ acp: true, pending: true, kind: "model" })).toEqual({ act: "ignore" });
    expect(planPick({ acp: false, pending: true, kind: "model" })).toEqual({ act: "ignore" });
  });

  it("for ACP, writes nothing down and remembers nothing", () => {
    expect(planPick({ acp: true, pending: false, kind: "model" })).toEqual({
      act: "send",
      optimistic: false,
      remember: null,
    });
  });

  it("for ACP, does not remember a preference even for a remembered kind", () => {
    // The agent owns its configuration; a Firetower-side default would fight
    // whatever `session/load` reports on the next start.
    for (const kind of ["model", "mode", "effort"] as const) {
      expect(planPick({ acp: true, pending: false, kind })).toMatchObject({ remember: null });
    }
  });

  it("for Claude and Codex, shows the choice at once and remembers it", () => {
    expect(planPick({ acp: false, pending: false, kind: "model" })).toEqual({
      act: "send",
      optimistic: true,
      remember: "model",
    });
  });

  it("remembers the three kinds that are a preference, and not the one that is not", () => {
    // Carried as the kind itself: the callback that stores a preference takes
    // only these three, and this is what keeps the other one away from it.
    for (const kind of ["model", "mode", "effort"] as const) {
      expect(planPick({ acp: false, pending: false, kind })).toMatchObject({ remember: kind });
    }
    expect(planPick({ acp: false, pending: false, kind: "sandbox" })).toMatchObject({
      remember: null,
    });
  });
});

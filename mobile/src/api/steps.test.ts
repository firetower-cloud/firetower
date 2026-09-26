import { describe, expect, test } from "vitest";
import { delegated, fold, mainline, summarise } from "./steps";
import type { Item } from "./conversation";
import type { ItemKind, ItemStatus } from "./generated/model";

/**
 * An item, with only the parts these rules read.
 *
 * `status` is passed at every call rather than defaulted: a default parameter
 * is used when the argument is `undefined`, so `ran("x", undefined)` — the way
 * to say "still running" — would have quietly produced a finished one.
 */
function item(id: string, kind: ItemKind, status: ItemStatus | undefined): Item {
  return { id, kind, status, text: "", output: "" };
}

const ran = (id: string) => item(id, "CommandExecution", "Completed");
const broke = (id: string) => item(id, "CommandExecution", "Failed");
const running = (id: string) => item(id, "CommandExecution", undefined);
const read = (id: string) => item(id, "FileRead", "Completed");
const said = (id: string) => item(id, "AssistantMessage", "Completed");
/** A read that handed back a screenshot. */
const shot = (id: string): Item => ({
  ...item(id, "FileRead", "Completed"),
  images: [{ mediaType: "image/png", data: "AAAA" }],
});
/** A reasoning block with its text left out, which is what models send. */
const mused = (id: string) => item(id, "Reasoning", "Completed");

describe("fold", () => {
  test("leaves a run too short to be worth hiding", () => {
    const rows = fold([ran("a"), ran("b")]);
    expect(rows.map((r) => r.type)).toEqual(["item", "item"]);
  });

  test("folds a long enough run into one row", () => {
    const rows = fold([ran("a"), ran("b"), ran("c")]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "group", id: "a" });
  });

  test("a step that handed back a picture never folds away", () => {
    // The whole reason the picture is carried: folded into "4 steps" it is
    // behind a click, which is indistinguishable from not being there.
    const rows = fold([ran("a"), ran("b"), shot("s"), ran("c")]);
    expect(rows.map((r) => r.type)).toEqual(["item", "item", "item", "item"]);
    expect(rows[2]).toMatchObject({ type: "item", item: { id: "s" } });
  });

  test("a picture breaks a run the way prose does", () => {
    const rows = fold([ran("a"), ran("b"), ran("c"), shot("s"), ran("d"), ran("e"), ran("f")]);
    expect(rows.map((r) => r.type)).toEqual(["group", "item", "group"]);
  });

  test("prose breaks a run in two", () => {
    // The sentence explaining what it did is the thing somebody scrolled back
    // for. It must never end up inside a fold.
    const rows = fold([ran("a"), ran("b"), ran("c"), said("s"), ran("d"), ran("e"), ran("f")]);
    expect(rows.map((r) => r.type)).toEqual(["group", "item", "group"]);
    expect(rows[1]).toMatchObject({ type: "item", item: { id: "s" } });
  });

  test("a run broken by prose is two short runs, and neither folds", () => {
    const rows = fold([ran("a"), ran("b"), said("s"), ran("c"), ran("d")]);
    expect(rows.map((r) => r.type)).toEqual(["item", "item", "item", "item", "item"]);
  });

  test("the step still running stays out of the group", () => {
    // A group that swallowed it would make a working session look frozen.
    const rows = fold([ran("a"), ran("b"), ran("c"), running("live")]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ type: "group", id: "a" });
    expect(rows[1]).toMatchObject({ type: "item", item: { id: "live" } });
  });

  test("mixed kinds fold together", () => {
    const rows = fold([ran("a"), read("b"), ran("c")]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "group" });
  });

  test("a failure inside does not break the run", () => {
    // It is marked on the summary instead — the group stays closed.
    const rows = fold([ran("a"), broke("b"), ran("c")]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "group" });
  });

  test("the group is keyed by its first item, not its position", () => {
    // Keyed by index, React remounts as items arrive and an open group snaps
    // shut. The id has to survive things being prepended.
    const later = fold([said("s"), ran("a"), ran("b"), ran("c")]);
    const group = later.find((r) => r.type === "group");
    expect(group).toMatchObject({ id: "a" });
  });

  test("an invisible reasoning block does not break a run", () => {
    // What models actually send: a reasoning block before every tool call,
    // with no text in it, which `Thought` draws as nothing. Three commands
    // that read as consecutive have to fold as consecutive.
    const rows = fold([mused("m1"), ran("a"), mused("m2"), ran("b"), mused("m3"), ran("c")]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "group", id: "a" });
    if (rows[0].type === "group") expect(rows[0].items).toHaveLength(3);
  });

  test("a reasoning block that has something to say is a row of its own", () => {
    const thought = item("t", "Reasoning", "Completed");
    thought.text = "weighing two options";
    const rows = fold([ran("a"), thought, ran("b"), ran("c")]);
    expect(rows.map((r) => r.type)).toEqual(["item", "item", "item", "item"]);
  });

  test("nothing in, nothing out", () => {
    expect(fold([])).toEqual([]);
  });
});

describe("summarise", () => {
  test("a run of one kind says what the kind was", () => {
    expect(summarise([ran("a"), ran("b"), ran("c")])).toMatchObject({
      verb: "ran",
      text: "3 commands",
      failed: 0,
    });
  });

  test("a mixed run says how much, not what", () => {
    expect(summarise([ran("a"), read("b"), ran("c")])).toMatchObject({
      verb: "did",
      text: "3 steps",
    });
  });

  test("failures are counted, so the row can be marked without opening", () => {
    expect(summarise([ran("a"), broke("b"), broke("c")]).failed).toBe(2);
  });
});

/**
 * Whose rail an item belongs on.
 *
 * The normaliser tags a subagent's tool calls with the task that owns them,
 * precisely so they can be kept off the main rail — see the comment on
 * `ItemStarted.task` in `ft-core`. Nothing read that tag, so every delegated
 * call was drawn twice: once inline, where it read as though the agent you are
 * talking to had made it, and once inside the card that actually owns it.
 */
describe("whose work it is", () => {
  const mine = (id: string): Item => ({ ...read(id), task: "task-1" });

  test("the main rail leaves a subagent's work to its own card", () => {
    const items = [ran("a"), mine("b"), mine("c"), ran("d")];
    expect(mainline(items).map((i) => i.id)).toEqual(["a", "d"]);
  });

  test("and the card gets exactly what it owns", () => {
    const items = [ran("a"), mine("b"), mine("c"), ran("d")];
    expect(delegated(items, "task-1").map((i) => i.id)).toEqual(["b", "c"]);
  });

  test("a second subagent does not collect the first one's work", () => {
    const theirs: Item = { ...read("e"), task: "task-2" };
    const items = [mine("b"), theirs];
    expect(delegated(items, "task-1").map((i) => i.id)).toEqual(["b"]);
    expect(delegated(items, "task-2").map((i) => i.id)).toEqual(["e"]);
  });

  test("folding the main rail cannot reach a subagent's work", () => {
    // The whole bug, in the shape it actually appeared: three delegated
    // commands in a row became a "ran 3 commands" group on the main rail.
    const items = [mine("b"), mine("c"), mine("d")];
    const rows = fold(mainline(items));
    expect(rows).toEqual([]);
  });
});

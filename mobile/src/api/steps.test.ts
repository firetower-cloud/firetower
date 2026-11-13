import { describe, expect, test } from "vitest";
import { delegated, fold, mainline, place, summarise } from "./steps";
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

/**
 * Where an artifact's card goes.
 *
 * The reported bug was that it went nowhere: every card was appended after the
 * transcript, so an artifact published an hour ago sat under the newest
 * message. These are the three answers, and the two shapes of "no row
 * matches" that have to stay apart — a window that starts after the artifact
 * is not the same thing as an artifact with no position at all.
 */
describe("place", () => {
  /** A line of prose at a log line: one item, one row, one reach. */
  const spoke = (id: string, lineNo: number): Item => ({ ...said(id), lineNo });
  /** A command at a log line, for the runs that fold. */
  const step = (id: string, lineNo: number): Item => ({ ...ran(id), lineNo });
  /** An artifact, as the placement reads one. */
  const made = (id: string, firstSeenLine: number | null) => ({ id, firstSeenLine });

  /** Three exchanges, each its own row, reaching 10, 20 and 30. */
  const loaded = () => fold([spoke("m1", 10), spoke("m2", 20), spoke("m3", 30)]);

  test("lands after the row the conversation had reached", () => {
    const placed = place(loaded(), [made("a1", 25)]);
    expect(placed.at.get(1)?.map((a) => a.id)).toEqual(["a1"]);
    expect(placed.before).toEqual([]);
    expect(placed.loose).toEqual([]);
  });

  test("lands on the row whose reach is exactly its line", () => {
    // The boundary the `<=` is for: the artifact was published *by* that line,
    // so the row that reached it is the row it belongs after.
    expect(place(loaded(), [made("a1", 20)]).at.get(1)?.map((a) => a.id)).toEqual(["a1"]);
  });

  test("newer than every loaded row sits after the last of them", () => {
    // Which is the bottom of the transcript — correctly, this time, because it
    // really is the newest thing that happened.
    const placed = place(loaded(), [made("a1", 99)]);
    expect(placed.at.get(2)?.map((a) => a.id)).toEqual(["a1"]);
    expect(placed.loose).toEqual([]);
  });

  test("older than every loaded row goes above the transcript", () => {
    // The bug as it was reported. A phone opens on the last few exchanges, so
    // this is the common case rather than the corner — and sending it to the
    // end puts the oldest artifact under the newest message.
    const placed = place(loaded(), [made("a1", 5)]);
    expect(placed.before.map((a) => a.id)).toEqual(["a1"]);
    expect(placed.at.size).toBe(0);
    expect(placed.loose).toEqual([]);
  });

  test("a row written before the column existed goes to the end", () => {
    const placed = place(loaded(), [made("a1", null)]);
    expect(placed.loose.map((a) => a.id)).toEqual(["a1"]);
    expect(placed.before).toEqual([]);
    expect(placed.at.size).toBe(0);
  });

  test("with no transcript to anchor to, every card goes to the end", () => {
    // An artifact outlives the workspace that made it, so this is a session
    // that still has cards and nothing to hang them on. Not `before`: above
    // nothing is not a position.
    const placed = place([], [made("a1", 5311), made("a2", null)]);
    expect(placed.loose.map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(placed.before).toEqual([]);
    expect(placed.at.size).toBe(0);
  });

  test("two artifacts against the same row stay together, in order", () => {
    const placed = place(loaded(), [made("a1", 21), made("a2", 29)]);
    expect(placed.at.get(1)?.map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(placed.at.size).toBe(1);
  });

  test("a transcript of nothing but what somebody typed anchors nothing", () => {
    // An optimistic item has no line, so the rows reach 0 — which says nothing
    // about where they are rather than "line zero". Read as a position it
    // would make every real artifact older than the window, and a card that
    // belongs halfway down would be captioned as published before a message
    // sent ten seconds ago.
    const placed = place(fold([said("typed-1")]), [made("a1", 5311)]);
    expect(placed.loose.map((a) => a.id)).toEqual(["a1"]);
    expect(placed.before).toEqual([]);
    expect(placed.at.size).toBe(0);
  });

  test("a folded group is not opened to put a card inside it", () => {
    // The publish was a shell command in the middle of a run of three. The
    // group's reach is past the artifact's line, so the card stops at the row
    // before it. Within one row, and the alternative is a card that vanishes
    // when somebody shuts the fold.
    const rows = fold([spoke("m1", 10), step("c1", 20), step("c2", 21), step("c3", 22)]);
    expect(rows.map((r) => r.type)).toEqual(["item", "group"]);
    expect(place(rows, [made("a1", 21)]).at.get(0)?.map((a) => a.id)).toEqual(["a1"]);
  });

  test("a page of history moves the card off the top and inline", () => {
    // Criterion 5, as data: the same artifact against a window that grew
    // upwards. Above the transcript while the row it anchors to is unread,
    // inline the moment it arrives.
    const artifact = made("a1", 15);
    expect(place(fold([spoke("m3", 30)]), [artifact]).before.map((a) => a.id)).toEqual(["a1"]);
    expect(place(loaded(), [artifact]).at.get(0)?.map((a) => a.id)).toEqual(["a1"]);
  });
});

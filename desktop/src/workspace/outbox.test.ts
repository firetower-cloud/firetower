import { describe, expect, it } from "vitest";
import { firstMessage, lost, nothingAttached, run, type Parcel, type Ports } from "./outbox";

/**
 * Delivering the first message to a workspace that was still being built.
 *
 * This is the only path in the client that sends something nobody is watching,
 * so every way it can go wrong has to end somewhere a person will see it. The
 * two that matter:
 *
 * - **The bring-up never finished.** Nothing has moved, so nothing is
 *   half-sent, and the words have to come back.
 * - **The send failed after the files landed.** The files are in the workspace
 *   and already named in the text, so what comes back must be *that* text —
 *   pressing send again has to deliver all of it without putting a single file
 *   in the workspace twice.
 */

const file = (name: string) => ({ name }) as unknown as File;
const picture = { mediaType: "image/png", data: "aaaa" };

const parcel = (over: Partial<Parcel> = {}): Parcel => ({
  text: "look at this",
  images: [],
  files: [],
  ...over,
});

/** Ports that work, and a log of what they were asked to do. */
function working(log: string[] = []): Ports & { log: string[] } {
  return {
    log,
    until: async () => void log.push("waited"),
    place: async (_id, f) => {
      log.push(`placed ${f.name}`);
      return `.firetower/attachments/${f.name}`;
    },
    send: async (_id, text) => void log.push(`sent ${JSON.stringify(text)}`),
  };
}

describe("delivering a first message", () => {
  it("waits for the agent before putting a single byte anywhere", async () => {
    const ports = working();
    await run("s_1", parcel({ files: [file("notes.md")] }), ports);
    // The order is the whole point: `attach_file` needs a workspace, and the
    // workspace is made after `create_session` has already answered.
    expect(ports.log).toEqual([
      "waited",
      "placed notes.md",
      'sent "look at this\\n\\n.firetower/attachments/notes.md"',
    ]);
  });

  it("names every file it placed, one per line under the sentence", async () => {
    const ports = working();
    await run("s_1", parcel({ files: [file("a.csv"), file("b.csv")] }), ports);
    expect(ports.log.at(-1)).toBe(
      'sent "look at this\\n\\n.firetower/attachments/a.csv\\n.firetower/attachments/b.csv"',
    );
  });

  it("sends the pictures beside the message rather than in it", async () => {
    const sent: { text: string; images: unknown[] }[] = [];
    await run("s_1", parcel({ images: [picture] }), {
      ...working(),
      send: async (_id, text, images) => void sent.push({ text, images }),
    });
    expect(sent).toEqual([{ text: "look at this", images: [picture] }]);
  });

  it("sends a message of nothing but pictures", async () => {
    const sent: string[] = [];
    await run("s_1", parcel({ text: "", images: [picture] }), {
      ...working(),
      send: async (_id, text) => void sent.push(text),
    });
    expect(sent).toEqual([""]);
  });

  it("says nothing when everything arrived", async () => {
    expect(await run("s_1", parcel({ files: [file("a.csv")] }), working())).toBeNull();
  });
});

describe("when the workspace never came up", () => {
  const refuse: Ports = {
    ...working(),
    until: async () => {
      throw new Error("the workspace failed to start");
    },
  };

  it("hands the words back, and places nothing", async () => {
    const log: string[] = [];
    const trouble = await run("s_1", parcel({ files: [file("a.csv")] }), {
      ...working(log),
      until: refuse.until,
    });
    expect(log).toEqual([]);
    expect(trouble?.text).toBe("look at this");
    expect(trouble?.why).toContain("the workspace failed to start");
  });

  it("names what was attached, because those have to be found again", async () => {
    const trouble = await run("s_1", parcel({ files: [file("a.csv")], images: [picture] }), refuse);
    expect(trouble?.why).toContain("Nothing was attached: a.csv, 1 image.");
  });

  it("says nothing about attachments when there were none", async () => {
    const trouble = await run("s_1", parcel(), refuse);
    expect(trouble?.why).toBe("Your first message was not sent — the workspace failed to start.");
  });
});

describe("when one file would not go in", () => {
  it("sends the rest and names the one that did not", async () => {
    const sent: string[] = [];
    const trouble = await run("s_1", parcel({ files: [file("ok.csv"), file("bad.csv")] }), {
      ...working(),
      place: async (_id, f) => {
        if (f.name === "bad.csv") throw new Error("the host went away");
        return `.firetower/attachments/${f.name}`;
      },
      send: async (_id, text) => void sent.push(text),
    });
    // Losing the whole message because one attachment failed would be worse
    // than sending it without that one and saying so.
    expect(sent).toEqual(["look at this\n\n.firetower/attachments/ok.csv"]);
    expect(trouble).toEqual({ why: "bad.csv could not be put in the workspace. Attach it again to send it." });
    // Nothing to put back: the message went.
    expect(trouble?.text).toBeUndefined();
  });

  it("says so even when it was the only thing to send", async () => {
    const trouble = await run("s_1", parcel({ text: "", files: [file("bad.csv")] }), {
      ...working(),
      place: async () => {
        throw new Error("no");
      },
    });
    expect(trouble?.why).toContain("bad.csv could not be put in the workspace");
  });
});

describe("when the send itself failed", () => {
  it("hands back the message with the paths in it, so nothing is uploaded twice", async () => {
    const trouble = await run("s_1", parcel({ files: [file("a.csv")] }), {
      ...working(),
      send: async () => {
        throw new Error("the agent is not listening");
      },
    });
    // The file is already in the workspace. What comes back is the text that
    // names it, so one press finishes the job rather than starting it again.
    expect(trouble?.text).toBe("look at this\n\n.firetower/attachments/a.csv");
    expect(trouble?.why).toContain("the agent is not listening");
  });
});

describe("the sentences", () => {
  it("names one lost file in the singular and several in a list", () => {
    expect(lost(["a.csv"])).toBe("a.csv could not be put in the workspace. Attach it again to send it.");
    expect(lost(["a.csv", "b.csv"])).toBe(
      "These could not be put in the workspace: a.csv, b.csv. Attach them again to send them.",
    );
    expect(lost([])).toBe("");
  });

  it("counts pictures and names files, which is all anybody can act on", () => {
    expect(nothingAttached({ files: [], images: [picture, picture] })).toBe("Nothing was attached: 2 images.");
    expect(nothingAttached({ files: [], images: [] })).toBe("");
  });

  it("builds the message the way the composer does", () => {
    expect(firstMessage("  hello  ", ["a", "b"])).toBe("hello\n\na\nb");
    expect(firstMessage("hello", [])).toBe("hello");
    expect(firstMessage("   ", ["a"])).toBe("a");
  });
});

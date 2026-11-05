import { beforeEach, describe, expect, it, vi } from "vitest";
import { useBackendId } from "~/client/http";
import { leaveDraft } from "./draft";
import {
  deliver,
  delivering,
  firstMessage,
  forget,
  lost,
  nothingAttached,
  portsFor,
  run,
  undelivered,
  untilReady,
  type Parcel,
  type Ports,
} from "./outbox";

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
 * - **The window moved to another Firetower.** A session id means nothing on a
 *   server that did not mint it, and the generated client picks its server when
 *   the call is made — so every call that leaves the machine has to be asked
 *   for again, and none of them may happen against the wrong one.
 */

/* `sessionStorage`, as `draft.ts` reaches for it. The draft is read back
   through its own key rather than with `takeDraft`, which would remove the
   thing under test. */
const store = new Map<string, string>();
const kept = (sessionId: string) => store.get(`firetower.draft.${sessionId}`) ?? null;
beforeEach(() => {
  /* One server, the way the provider sets it for every generated call. `forget`
     and `delivering` read it, so the ambient one and the one parcels are
     addressed to are the same here — except where a test moves it. */
  useBackendId("a");
  store.clear();
  vi.stubGlobal("window", {
    sessionStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  });
});

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
    mine: () => true,
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

/** A bring-up that never finishes, for the blocks below. */
const never: Pick<Ports, "until"> = {
  until: async () => {
    throw new Error("the workspace failed to start");
  },
};

/** A wait held open, for the tests that look at an attempt in flight. */
function gated(): { until: () => Promise<void>; open: () => void } {
  let open!: () => void;
  const held = new Promise<void>((done) => {
    open = done;
  });
  return { until: () => held, open: () => open() };
}

describe("which Firetower a parcel belongs to", () => {
  /* The failure this is here for: a person starts a workspace on A with a file
     attached, the bring-up is minutes, and they look at B in the sidebar. The
     client resolves its server when the call is made, so without this the wait
     polls B for a session B never minted — and a B that answers with one
     `AgentLaunched` of its own is handed the file. */
  it("never asks another one about a session it did not mint", async () => {
    // Nothing is read: the guard is before the first request, not after it.
    await expect(untilReady("s_1", () => false)).rejects.toThrow("the window moved to another Firetower");
  });

  it("stops rather than uploading to whatever server is current now", async () => {
    const log: string[] = [];
    const trouble = await run("s_1", parcel({ files: [file("salaries.xlsx")] }), {
      ...working(log),
      mine: () => false,
    });
    expect(log).toEqual(["waited"]);
    expect(trouble?.text).toBe("look at this");
    expect(trouble?.why).toContain("the window moved to another Firetower");
    // The same handback as a bring-up that never finished: nothing moved.
    expect(trouble?.why).toContain("Nothing was attached: salaries.xlsx.");
  });

  it("keeps the files that landed before it moved and names the ones that did not", async () => {
    const log: string[] = [];
    let moved = false;
    const trouble = await run("s_1", parcel({ files: [file("a.csv"), file("b.csv")] }), {
      ...working(log),
      mine: () => !moved,
      place: async (_id, f) => {
        moved = true;
        log.push(`placed ${f.name}`);
        return `.firetower/attachments/${f.name}`;
      },
    });
    // a.csv went in; b.csv was never offered to anybody, and neither was the
    // message — which comes back naming the path that does exist.
    expect(log).toEqual(["waited", "placed a.csv"]);
    expect(trouble?.text).toBe("look at this\n\n.firetower/attachments/a.csv");
    expect(trouble?.why).toContain("the window moved to another Firetower");
    expect(trouble?.why).toContain("b.csv could not be put in the workspace");
  });

  it("files what could not be delivered under the server it was for", async () => {
    await deliver({ server: "a", sessionId: "s_key" }, parcel(), { ...working(), until: never.until });
    expect(undelivered("a", "s_key")?.text).toBe("look at this");
    // The same id on another Firetower is another session, or nobody's.
    expect(undelivered("b", "s_key")).toBeUndefined();
  });

  it("treats the same session id on two servers as two parcels", async () => {
    const onA: string[] = [];
    const onB: string[] = [];
    const slow = gated();
    const first = deliver({ server: "a", sessionId: "s_two" }, parcel(), { ...working(onA), until: slow.until });
    // Not swallowed by the one still in flight: `going` is per server too.
    await deliver({ server: "b", sessionId: "s_two" }, parcel(), working(onB));
    expect(onB).toContain('sent "look at this"');
    slow.open();
    await first;
    expect(onA).toContain('sent "look at this"');
  });
});

describe("the conversation a trouble has to reach", () => {
  /* `Workbench` draws whichever of a workspace's runs it judges you came to
     read, and `Composer` asks about that one. A second agent added during the
     bring-up, or the started run ending, is enough for that to be a different
     run — and a trouble filed only under the run that was started is then a
     sentence nobody is ever shown. */
  const where = { server: "a", sessionId: "s_started", workspaceId: "w_1" };

  beforeEach(async () => {
    forget("s_started", "w_1");
    await deliver(where, parcel(), { ...working(), until: never.until });
  });

  it("can be asked for by the run that was started", () => {
    expect(undelivered("a", "s_started")?.text).toBe("look at this");
  });

  it("can be asked for by another run in the same workspace", () => {
    expect(undelivered("a", "s_second", "w_1")?.text).toBe("look at this");
  });

  it("is not offered to a workspace it was not for", () => {
    expect(undelivered("a", "s_second", "w_other")).toBeUndefined();
  });

  it("is said once, whichever run said it", () => {
    // The run on screen is not the one the parcel was filed under, so forgetting
    // by its ids has to clear the other key too or the next run says it again.
    forget("s_second", "w_1");
    expect(undelivered("a", "s_second", "w_1")).toBeUndefined();
    expect(undelivered("a", "s_started")).toBeUndefined();
  });
});

describe("the words, while they are still only here", () => {
  /* With something attached the prompt is held back out of `CreateWorkspace` —
     the first message has to be text, pictures and paths together — so until
     this lands the only other copy of it is the one the New page leaves in
     `draft.ts`. Which is to say: it is there to be taken out again, and when. */
  it("leaves the New page's copy alone while the attempt is in flight", async () => {
    leaveDraft("s_flight", "look at this");
    const slow = gated();
    const attempt = deliver({ server: "a", sessionId: "s_flight" }, parcel(), { ...working(), until: slow.until });
    // The composer asks this before it takes a draft: the draft is a copy of
    // the message being sent, and offering it would invite giving the agent the
    // same first words a second time.
    expect(delivering("s_flight")).toBe(true);
    expect(kept("s_flight")).toBe("look at this");
    slow.open();
    await attempt;
  });

  it("takes it out once the agent has them", async () => {
    leaveDraft("s_landed", "look at this");
    await deliver({ server: "a", sessionId: "s_landed" }, parcel(), working());
    expect(delivering("s_landed")).toBe(false);
    expect(kept("s_landed")).toBeNull();
  });

  it("takes it out when it hands them back instead, so they are not offered twice", async () => {
    leaveDraft("s_failed", "look at this");
    await deliver({ server: "a", sessionId: "s_failed" }, parcel(), { ...working(), until: never.until });
    // One copy, in the handback the composer puts in the box — not that one
    // *and* a draft on top of it at the next mount.
    expect(undelivered("a", "s_failed")?.text).toBe("look at this");
    expect(kept("s_failed")).toBeNull();
  });
});

describe("the Firetower a parcel was addressed to", () => {
  /* Start is pressed on A, and the sidebar moves to B while `create_session`
     is still in flight — which unmounts the New page, so this is also the case
     where the create's own callbacks no longer run. The address is read when
     Start is pressed, so the parcel still says A; `portsFor` is the real thing
     rather than a `mine` written here, and it refuses before a single request
     is made. */
  it("is the one Start was pressed on, not the one current when the create answers", async () => {
    useBackendId("b");
    await deliver(
      { server: "a", sessionId: "s_addressed" },
      parcel({ files: [file("salaries.xlsx")] }),
      portsFor("a"),
    );
    const trouble = undelivered("a", "s_addressed");
    // Filed under A, where the person sees it when they go back to it — and
    // naming the file, which is still theirs and still nowhere.
    expect(trouble?.text).toBe("look at this");
    expect(trouble?.why).toContain("the window moved to another Firetower");
    expect(trouble?.why).toContain("Nothing was attached: salaries.xlsx.");
  });
});

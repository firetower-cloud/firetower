import { describe, expect, it } from "vitest";
import { relays } from "./relay";

describe("relays", () => {
  it("reads a hand-back: kind, session, name, and the body without the mark", () => {
    const text = "⟦ft:handback:s_abc:reviewer⟧\n\nTwo findings.\n\n(branch `agent/x`)";
    const [r] = relays(text);
    expect(r).toMatchObject({ kind: "handback", id: "s_abc", name: "reviewer" });
    expect(r.body).toBe("Two findings.\n\n(branch `agent/x`)");
  });

  it("keeps a name with spaces and a slash intact", () => {
    const [r] = relays("⟦ft:handback:s_1:Hello / saluteur⟧\n\nBonjour !");
    expect(r.name).toBe("Hello / saluteur");
    expect(r.body).toBe("Bonjour !");
  });

  it("reads a steer from a lead", () => {
    const [r] = relays("⟦ft:steer:s_lead:rate-limit⟧\n\nUse the fixture db.");
    expect(r).toMatchObject({ kind: "steer", id: "s_lead", name: "rate-limit" });
    expect(r.body).toBe("Use the fixture db.");
  });

  it("splits several results joined into one turn into one card each", () => {
    const text =
      "⟦ft:handback:s_a:reviewer⟧\n\nFindings here.\n\n---\n\n⟦ft:handback:s_b:qa⟧\n\n1 failing.";
    const rs = relays(text);
    expect(rs.map((r) => r.id)).toEqual(["s_a", "s_b"]);
    expect(rs[0].body).toBe("Findings here.");
    expect(rs[1].body).toBe("1 failing.");
  });

  it("is nothing for an ordinary message a person typed", () => {
    expect(relays("just a normal message")).toEqual([]);
    expect(relays("")).toEqual([]);
    expect(relays(undefined)).toEqual([]);
  });
});

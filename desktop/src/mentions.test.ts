import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Artifact } from "~/api/generated/model";
import { handleFor, mentionBlock, rankArtifacts, segments, splitMentions, withoutHandle } from "./mentions";

const NOW = Date.parse("2026-10-28T12:00:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

/** Just enough of an artifact for the two things this file reads off one. */
function artifact(over: Partial<Artifact> & { slug: string; title: string }): Artifact {
  return {
    id: `a_${over.slug}`,
    version: 1,
    versionId: null,
    bytes: 1000,
    hasPoster: false,
    mayShare: true,
    mine: true,
    path: `u/kevin/${over.slug}`,
    fromSessionId: "s_other",
    fromWorkspaceName: "another workspace",
    updatedAt: ago(120),
    firstSeenLine: null,
    url: "",
    posterUrl: "",
    ...over,
  };
}

const HERE = "s_here";
const pricing = artifact({ slug: "pricing", title: "Pricing, three tiers", version: 3, fromWorkspaceName: "pricing rework" });
const checkout = artifact({ slug: "checkout-flow", title: "Checkout flow", fromSessionId: HERE, fromWorkspaceName: "checkout flow", updatedAt: ago(12) });
const funnel = artifact({ slug: "q3-funnel", title: "Q3 funnel", version: 2, mine: false, path: "d/growth/q3-funnel", fromWorkspaceName: null, updatedAt: ago(60 * 24) });
const onboarding = artifact({ slug: "onboarding", title: "Onboarding, five screens", version: 4, fromWorkspaceName: "auth cleanup", updatedAt: ago(60 * 72) });
const LIBRARY = [onboarding, funnel, pricing, checkout];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("which artifacts are offered after @", () => {
  it("puts this workspace's first, then the rest newest first", () => {
    expect(rankArtifacts(LIBRARY, "", HERE).map((a) => a.slug)).toEqual(["checkout-flow", "pricing", "q3-funnel", "onboarding"]);
  });

  it("ranks a title that starts with the query above one that merely contains it", () => {
    const tiers = artifact({ slug: "tiers-compared", title: "Tiers compared" });
    expect(rankArtifacts([pricing, tiers], "tier", HERE).map((a) => a.slug)).toEqual(["tiers-compared", "pricing"]);
  });

  it("matches a word inside the title and the slug", () => {
    expect(rankArtifacts(LIBRARY, "five", HERE).map((a) => a.slug)).toEqual(["onboarding"]);
    expect(rankArtifacts(LIBRARY, "flow", HERE).map((a) => a.slug)).toEqual(["checkout-flow"]);
  });

  it("falls back to where it came from", () => {
    expect(rankArtifacts(LIBRARY, "growth", HERE).map((a) => a.slug)).toEqual(["q3-funnel"]);
    expect(rankArtifacts(LIBRARY, "auth", HERE).map((a) => a.slug)).toEqual(["onboarding"]);
  });

  it("offers nothing for a path, which is the files' turn", () => {
    expect(rankArtifacts(LIBRARY, "src/", HERE)).toEqual([]);
  });

  it("offers nothing for a query that matches nothing", () => {
    expect(rankArtifacts(LIBRARY, "zebra", HERE)).toEqual([]);
  });
});

describe("the handle a pick leaves in the sentence", () => {
  it("is the slug", () => {
    expect(handleFor(pricing, [])).toBe("pricing");
  });

  it("is the same handle for the same artifact twice", () => {
    expect(handleFor(pricing, [{ artifact: pricing, handle: "pricing" }])).toBe("pricing");
  });

  it("numbers a second artifact with the same slug", () => {
    const hers = artifact({ slug: "pricing", title: "Pricing (Lisa's)", id: "a_hers", mine: false, path: "d/design/pricing" });
    const held = [{ artifact: pricing, handle: "pricing" }];
    expect(handleFor(hers, held)).toBe("pricing-2");
    const third = artifact({ slug: "pricing", title: "Pricing (Marc's)", id: "a_his", mine: false, path: "d/growth/pricing" });
    expect(handleFor(third, [...held, { artifact: hers, handle: "pricing-2" }])).toBe("pricing-3");
  });
});

describe("taking a handle out of the sentence", () => {
  it("closes the sentence up around it", () => {
    expect(withoutHandle("Make it match @pricing — same weight.", "pricing")).toBe("Make it match — same weight.");
  });

  it("takes it from the end, and before punctuation", () => {
    expect(withoutHandle("Compare it with @pricing", "pricing")).toBe("Compare it with ");
    expect(withoutHandle("Like @pricing, but blue.", "pricing")).toBe("Like , but blue.");
  });

  it("leaves a longer handle and a mid-word match alone", () => {
    expect(withoutHandle("See @pricing-2 and email@pricing.com", "pricing")).toBe("See @pricing-2 and email@pricing.com");
  });
});

describe("what the agent is told", () => {
  it("names the handle, the title, the version, the origin and the page", () => {
    const block = mentionBlock([{ handle: "pricing", artifact: pricing, path: ".firetower/attachments/pricing-v3.html" }], HERE);
    expect(block).toBe(
      [
        "Mentioned artifacts:",
        '- @pricing is "Pricing, three tiers" (v3), published 2h ago from the workspace "pricing rework". Page: .firetower/attachments/pricing-v3.html',
      ].join("\n"),
    );
  });

  it("says when it was made here, and when it is a zip", () => {
    const block = mentionBlock(
      [
        { handle: "checkout-flow", artifact: checkout, path: ".firetower/artifacts/checkout-flow/index.html" },
        { handle: "q3-funnel", artifact: funnel, path: ".firetower/attachments/q3-funnel-v2.zip" },
      ],
      HERE,
    );
    expect(block.split("\n")).toEqual([
      "Mentioned artifacts:",
      '- @checkout-flow is "Checkout flow" (v1), made in this workspace. Page: .firetower/artifacts/checkout-flow/index.html',
      '- @q3-funnel is "Q3 funnel" (v2), shared with you in "growth". Files: .firetower/attachments/q3-funnel-v2.zip (unzip it; the page is index.html)',
    ]);
  });

  it("says nothing when there is nothing", () => {
    expect(mentionBlock([], HERE)).toBe("");
  });
});

describe("reading the block back out of a message", () => {
  const text = "Make it match @pricing — same weight.";

  it("round-trips what the composer wrote, zip and all", () => {
    const block = mentionBlock(
      [
        { handle: "pricing", artifact: pricing, path: ".firetower/attachments/pricing-v3.html" },
        { handle: "q3-funnel", artifact: funnel, path: ".firetower/attachments/q3-funnel-v2.zip" },
      ],
      HERE,
    );
    expect(splitMentions(`${text}\n\n${block}`)).toEqual({
      said: text,
      mentions: [
        { handle: "pricing", title: "Pricing, three tiers", version: 3, path: ".firetower/attachments/pricing-v3.html" },
        { handle: "q3-funnel", title: "Q3 funnel", version: 2, path: ".firetower/attachments/q3-funnel-v2.zip" },
      ],
    });
  });

  it("keeps the file paths a dropped file appends, between the text and the block", () => {
    const message = `${text}\n\n.firetower/attachments/report.csv\n\n${mentionBlock([{ handle: "pricing", artifact: pricing, path: "p.html" }], HERE)}`;
    expect(splitMentions(message).said).toBe(`${text}\n\n.firetower/attachments/report.csv`);
  });

  it("leaves a message with no block, or a block it cannot read, as it is", () => {
    expect(splitMentions(text)).toEqual({ said: text, mentions: [] });
    const odd = `${text}\n\nMentioned artifacts:\n- something else entirely`;
    expect(splitMentions(odd)).toEqual({ said: odd, mentions: [] });
    const inline = "I wrote Mentioned artifacts: in a sentence";
    expect(splitMentions(inline)).toEqual({ said: inline, mentions: [] });
  });
});

describe("cutting a sentence around its handles", () => {
  it("draws a handle as one and the rest as text", () => {
    expect(segments("Make it match @pricing — same.", ["pricing"])).toEqual([
      { kind: "text", value: "Make it match " },
      { kind: "handle", value: "@pricing" },
      { kind: "text", value: " — same." },
    ]);
  });

  it("prefers the longer handle and ignores an address", () => {
    expect(segments("@pricing-2 beats @pricing; not kevin@pricing.com", ["pricing", "pricing-2"])).toEqual([
      { kind: "handle", value: "@pricing-2" },
      { kind: "text", value: " beats " },
      { kind: "handle", value: "@pricing" },
      { kind: "text", value: "; not kevin@pricing.com" },
    ]);
  });

  it("is just the text when there are no handles", () => {
    expect(segments("plain", [])).toEqual([{ kind: "text", value: "plain" }]);
    expect(segments("", ["pricing"])).toEqual([]);
  });
});

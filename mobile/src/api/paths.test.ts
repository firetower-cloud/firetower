import { describe, expect, it } from "vitest";
import { split } from "~/api/paths";

describe("split", () => {
  it("takes the name off the end", () => {
    expect(split("crates/ft-server/src/notify.rs")).toEqual({
      name: "notify.rs",
      dir: "crates/ft-server/src",
    });
  });

  /* The one that shipped: no slash, `lastIndexOf` is -1, and `slice(0, -1)`
     hands back the name minus its last letter. */
  it("leaves a root file no directory at all", () => {
    expect(split("AGENTS.md")).toEqual({ name: "AGENTS.md", dir: "" });
  });

  it("does not mistake a dot for a separator", () => {
    expect(split("justfile")).toEqual({ name: "justfile", dir: "" });
  });

  it("keeps a leading directory of one segment", () => {
    expect(split("mobile/STYLE.md")).toEqual({ name: "STYLE.md", dir: "mobile" });
  });

  it("survives a trailing slash without inventing a name", () => {
    expect(split("mobile/src/")).toEqual({ name: "", dir: "mobile/src" });
  });
});

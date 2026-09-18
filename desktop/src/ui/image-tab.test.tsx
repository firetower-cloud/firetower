/**
 * The tab a screenshot opens in.
 *
 * Rendered against a seeded cache under the exact key `useFileText` stores
 * under, so what is on screen is what the tab did with contents it was handed
 * — no network, no worker. The thing worth proving is narrow and was the whole
 * bug: a picture draws, rather than being described.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ImageTab } from "./ImageTab";
import { FileTab } from "./FileTab";
import type { Contents } from "~/api/text";
import type { Session } from "~/api/generated/model";

const SESSION = { id: "s_01test", title: "A session", workspaceId: "w_01test" } as Session;
const SHOT = "docs/shot.png";

function draw(path: string, contents: Contents, Tab: typeof ImageTab | typeof FileTab) {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false } },
  });
  cache.setQueryData(["file-text", SESSION.id, path], contents);
  return renderToStaticMarkup(
    <QueryClientProvider client={cache}>
      <Tab session={SESSION} path={path} />
    </QueryClientProvider>,
  );
}

const picture = (bytes = 42_000): Contents => ({
  kind: "image",
  url: "blob:firetower/abc-123",
  mediaType: "image/png",
  bytes,
});

describe("a screenshot in a tab", () => {
  it("draws the picture", () => {
    const html = draw(SHOT, picture(), ImageTab);
    expect(html).toContain("<img");
    expect(html).toContain("blob:firetower/abc-123");
  });

  /* The sentence this feature exists to stop showing. */
  it("does not describe it instead of drawing it", () => {
    expect(draw(SHOT, picture(), ImageTab)).not.toContain("Nothing to draw");
  });

  it("says how big it is, so a blank-looking capture can be told from a broken one", () => {
    expect(draw(SHOT, picture(42_000), ImageTab)).toContain("42 KB");
  });

  it("reports a picture past the cap rather than trying to draw it", () => {
    const html = draw(SHOT, { kind: "huge", bytes: 12_000_000 }, ImageTab);
    expect(html).not.toContain("<img");
    expect(html).toContain("too much to put on a screen");
  });

  /* A file tab handed a picture would still be a file tab; the split is done
     by the workbench, and this is the half that proves the old path is
     unchanged for everything that is not a picture. */
  it("leaves the file tab's answer for real binaries alone", () => {
    const html = draw("Cargo.lock.bin", { kind: "binary", bytes: 900_000 }, FileTab);
    expect(html).toContain("Nothing to draw");
  });

  /*
   * The refusal branch — a path the worker will not reach — is not here on
   * purpose. React Query suppresses error state during server rendering so the
   * client can retry, and `renderToStaticMarkup` is the only renderer this
   * project has; the branch always draws as pending, so a test of it would
   * assert the harness rather than the tab. The wording it shows is pinned
   * where it is produced instead, in `ft-worker`'s `inside`.
   */
});

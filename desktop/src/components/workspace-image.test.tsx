/**
 * A picture inside what the agent wrote.
 *
 * `![the failing state](docs/shot.png)` used to fall through to
 * react-markdown's default `<img>`, pointed at the app's own origin — a
 * request for a file the app does not serve, and one that could carry no
 * session token even if it did. So the one thing worth asserting is that a
 * workspace path never reaches the DOM as a bare `src`.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Markdown } from "./Markdown";
import { ImagesFrom, isWorkspaceSrc } from "./WorkspaceImage";

function draw(markdown: string, session: string | null = null) {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnMount: false } },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={cache}>
      <ImagesFrom.Provider value={{ session }}>
        <Markdown>{markdown}</Markdown>
      </ImagesFrom.Provider>
    </QueryClientProvider>,
  );
}

describe("isWorkspaceSrc", () => {
  it("claims a path", () => {
    expect(isWorkspaceSrc("docs/shot.png")).toBe(true);
    expect(isWorkspaceSrc("/tmp/shot.png")).toBe(true);
  });

  it("leaves anything already fetchable alone", () => {
    expect(isWorkspaceSrc("https://example.com/a.png")).toBe(false);
    expect(isWorkspaceSrc("http://example.com/a.png")).toBe(false);
    expect(isWorkspaceSrc("data:image/png;base64,AAAA")).toBe(false);
    expect(isWorkspaceSrc("blob:firetower/abc")).toBe(false);
    expect(isWorkspaceSrc("//cdn.example.com/a.png")).toBe(false);
    expect(isWorkspaceSrc(undefined)).toBe(false);
  });
});

describe("a picture in what the agent wrote", () => {
  /* The regression: a workspace path must never become an `<img src>` the
     browser is asked to fetch on its own. */
  it("does not emit a bare src for a workspace path", () => {
    const html = draw("![the failing state](docs/shot.png)");
    expect(html).not.toContain('src="docs/shot.png"');
  });

  it("says why, rather than showing a broken image, when there is no session", () => {
    const html = draw("![the failing state](docs/shot.png)");
    expect(html).toContain("the failing state");
    expect(html).toContain("no workspace to read it from");
  });

  it("is looking for it once there is a session to look in", () => {
    expect(draw("![shot](docs/shot.png)", "s_01test")).toContain("looking for it");
  });

  /* A URL is not read through the workspace — the override is for paths — and
     is not fetched either: rendering it would send a request nobody chose to
     make. It becomes a link. See `markdown-render.test.tsx`. */
  it("turns a real URL into a link rather than fetching it", () => {
    const html = draw("![logo](https://example.com/logo.png)");
    expect(html).not.toContain("<img");
    expect(html).toContain('href="https://example.com/logo.png"');
  });
});

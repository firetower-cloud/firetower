/**
 * The conversation's markdown, as a page you can photograph.
 *
 * Not a mock of the renderer — **the renderer**, `components/Markdown.tsx`,
 * inside `Chat.tsx`'s own column: `mx-auto w-full max-w-[46rem] px-8` on
 * `bg-panel`, which is what a reply is drawn in. The specimens are the ones
 * #FT-B is about, where the answer is a *layout* — how wide a column came
 * out, where a line broke — and nothing in a unit test can see one.
 *
 * The address is the specimen: `/prose.html?only=roles`, `?only=wide`.
 * `?pane=` narrows the space the column is given, for a pane smaller than the
 * reading measure. Without `only` the page draws all of them, which is the
 * one to open by hand.
 *
 * Dev only. Vite serves it; it is not a build entry, so it cannot reach a
 * production bundle — the same arrangement as `demo.html` and `review.html`.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Markdown } from "~/components/Markdown";
import "~/theme";
import "~/styles.css";

/** The reported case: short labels in the first column, sentences beside them. */
const ROLES = `
| Role | What it is for | How it behaves |
| --- | --- | --- |
| Engineering Manager | Owns the ticket from specification to merge, and is the only role that merges a pull request. | Reads the brief, splits it into independently shippable tickets, and hands each one to an engineer with its acceptance criteria attached. |
| Security Advisor | Reviews a branch for what a functional review does not look at: secrets, injection, and anything widening the blast radius. | Signs off, or names the exact change it wants and the line it wants it on, and holds the merge until that has been answered. |
| Engineer | Implements one ticket against an approved specification. | Investigates first, keeps the diff inside the ticket, writes the tests it names, and hands back a draft pull request. |
`.trim();

/** The thing the wrapping rule is there for, in the place it is there for. */
const URLS = `
The failing run is https://github.com/firetower-cloud/firetower/actions/runs/19284733120/job/55132004412?pr=483&check_suite_focus=true#step:7:214 and it was cut from b820cd7f0e7a4d2c91f8e5a6c3b7d4e2f1a09c8be4d7c6b5a493827160fedcba, which the generator wrote into desktop/src/api/generated/model/sessionStatusSummaryByRepositoryAndWorkspace.ts.
`.trim();

/** More columns than the column has room for, all of them breakable. */
const WIDE = `
| Workspace | Repository | Branch | Machine | Agent | State | Waiting on | Last touched |
| --- | --- | --- | --- | --- | --- | --- | --- |
| streamline-quick-table-columns | firetower-cloud/firetower | agent/okay-so-i-would-like-to-streamline-a-quick-table-columns | mbp-kevin-16 | Engineer | working | nobody | 4 minutes ago |
| export-removal | firetower-cloud/firetower | agent/okay-so-i-would-like-to-streamline-a-quick-export-removal | mbp-kevin-16 | Security Advisor | needs you | the merge question | 11 minutes ago |
`.trim();

/** And one that genuinely cannot be made to fit: two cells with no break in
    them, which together are wider than the column however it is divided. */
const UNBREAKABLE = `
| Commit | Parent | Subject | Signed |
| --- | --- | --- | --- |
| b820cd7f0e7a4d2c91f8e5a6c3b7d4e2f1a09c8be4d7c6b5a493827160fedcba | 2294a4d4f1e0b9c8a7d6e5f4c3b2a1908f7e6d5c4b3a29180706f5e4d3c2b1a0 | the conversation's tables stop collapsing their columns | yes |
| ff65a6ecd3b2a1908f7e6d5c4b3a29180706f5e4d3c2b1a0b9c8a7d6e5f4c3b2 | 5c4b3a29180706f5e4d3c2b1a0b9c8a7d6e5f4c3b2a1908f7e6d5c4b3a291807 | refresh Cargo.lock | yes |
`.trim();

/** Everything else a reply is made of, which this change may not touch. */
const PROSE = `
# A heading an agent wrote

## And the section under it

Running text, with \`desktop/src/styles.css\` named inline and a [link](https://example.com) in it.

- A list item
- A second one, long enough to wrap inside the reading measure so the rhythm of the list is visible
  - And one nested under it

1. First
2. Second

> A quotation, which is how an agent restates the thing it was asked.

\`\`\`rust
fn main() {
    println!("a fenced block, with its own horizontal scroll and a line long enough to need it");
}
\`\`\`

- [ ] Something not done
- [x] Something done
`.trim();

const SPECIMENS: Record<string, string> = {
  roles: ROLES,
  url: URLS,
  wide: WIDE,
  unbreakable: UNBREAKABLE,
  prose: PROSE,
};

const asked = new URLSearchParams(window.location.search);
const only = asked.get("only");
const pane = asked.get("pane");
const drawn = only && SPECIMENS[only] ? [only] : Object.keys(SPECIMENS);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div className="min-h-screen bg-panel">
      <div className="mx-auto" style={pane ? { width: `${pane}px` } : undefined}>
        {drawn.map((id) => (
          <section key={id} data-shot={id} className="border-b border-line-soft">
            <div className="mx-auto w-full max-w-[46rem] px-8 pt-8 pb-4">
              <div className="prose-desk">
                <Markdown>{SPECIMENS[id]!}</Markdown>
              </div>
            </div>
          </section>
        ))}
      </div>
    </div>
  </StrictMode>,
);

"use client";

import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * How wide a sentence gets.
 *
 * On the prose elements rather than around the whole document, because a
 * drawing is not prose: agents draw boxes and arrows, and a diagram clipped to
 * a reading measure is a diagram with its right-hand side missing. Blocks and
 * tables take the column instead, so widening the conversation widens them
 * with nothing to change here.
 */
const MEASURE = "max-w-[72ch]";

/**
 * Whether a `<code>` is a block or a chip.
 *
 * **Not the language class.** That was the rule before, and it was wrong for
 * every drawing anybody has ever written: `mdast-util-to-hast` only sets
 * `language-*` when the fence names one, so a bare ``` fence arrived with no
 * class, took the inline branch, and got `white-space: nowrap` — which
 * collapses a diagram's newlines into spaces and renders it as a single
 * infinitely-scrolling line.
 *
 * Structure answers it properly. Inline code is never inside a `<pre>`; block
 * code always is, tagged or not, closed or not — and "not closed" is most of a
 * streaming turn. The class is still honoured so that a `<code>` reached any
 * other way is not mistaken for prose.
 */
export function isBlockCode(inPre: boolean, className?: string): boolean {
  return inPre || /language-/.test(className ?? "");
}

/** Set by `pre`, read by the `code` inside it. */
const InPre = createContext(false);

/**
 * What the agent wrote, as it meant it.
 *
 * Agents write markdown — lists, headings, fenced code — and rendering it as
 * plain text shows the punctuation instead of the structure. This is small on
 * purpose: it styles the elements the agent actually uses and nothing else.
 *
 * ## Two things it deliberately does
 *
 * **No raw HTML.** The content is model output arriving over a stream. Nothing
 * here enables `rehype-raw` or `dangerouslySetInnerHTML`, so a session that
 * prints a `<script>` tag shows the tag.
 *
 * **Renders half a document without complaining.** Text arrives mid-token, so
 * for most of a turn this is asked to draw an unclosed fence or a list with one
 * item. The parser handles that; the components below must not assume otherwise
 * — which is why none of them look at siblings or counts.
 *
 * Memoised on the text: a streaming turn re-renders on every delta, and every
 * other item on screen is unchanged.
 */
export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <div className="ft-md text-body text-text">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Paragraph spacing lives here rather than in a stylesheet so the
          // last one does not push the next item away.
          p: ({ children }) => <p className={`mb-3.5 last:mb-0 ${MEASURE}`}>{children}</p>,

          h1: ({ children }) => <Heading level={1}>{children}</Heading>,
          h2: ({ children }) => <Heading level={2}>{children}</Heading>,
          h3: ({ children }) => <Heading level={3}>{children}</Heading>,
          h4: ({ children }) => <Heading level={3}>{children}</Heading>,
          h5: ({ children }) => <Heading level={3}>{children}</Heading>,
          h6: ({ children }) => <Heading level={3}>{children}</Heading>,

          ul: ({ children }) => (
            <ul
              className={`mb-3.5 flex list-disc flex-col gap-1.5 pl-5 last:mb-0 marker:text-mute ${MEASURE}`}
            >
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol
              className={`mb-3.5 flex list-decimal flex-col gap-1.5 pl-5 last:mb-0 marker:text-mute ${MEASURE}`}
            >
              {children}
            </ol>
          ),
          li: ({ children }) => <li className="pl-0.5">{children}</li>,

          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              // Model output, so the link is untrusted: this stops the opened
              // page reaching back through `window.opener`.
              rel="noreferrer noopener"
              className="text-bone underline decoration-line underline-offset-2 transition-colors hover:decoration-mute"
            >
              {children}
            </a>
          ),

          strong: ({ children }) => <strong className="font-semibold text-bone">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          del: ({ children }) => <del className="text-mute line-through">{children}</del>,

          blockquote: ({ children }) => (
            <blockquote
              className={`mb-3.5 border-l-2 border-line pl-4 text-dim last:mb-0 ${MEASURE}`}
            >
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-5 border-line" />,

          code: ({ className, children }) => <Code className={className}>{children}</Code>,
          pre: ({ children }) => <Block>{children}</Block>,

          // Tables come from the GitHub extension, and an agent reaching for
          // one usually has something worth lining up.
          table: ({ children }) => (
            <div className="mb-3.5 overflow-x-auto last:mb-0">
              <table className="w-full border-collapse text-ui">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b border-line px-2.5 py-1.5 text-left font-medium text-dim">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-b border-line-soft px-2.5 py-2 align-top">{children}</td>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});

/** A path in a sentence, or a drawing in a block — `isBlockCode` decides. */
function Code({ className, children }: { className?: string; children: React.ReactNode }) {
  const inPre = useContext(InPre);

  if (!isBlockCode(inPre, className)) {
    // A chip rather than a tint. Agents write paths and symbols inline
    // constantly, and at this density a background alone does not separate
    // them from the sentence around them.
    return (
      <code className="rounded-sm border border-line bg-raise px-[5px] py-[1.5px] font-mono text-meta whitespace-nowrap text-bone">
        {children}
      </code>
    );
  }
  // Scrolling belongs to the `pre`, which is the element that knows how wide
  // it is allowed to be.
  return <code className="block font-mono text-code whitespace-pre">{children}</code>;
}

/**
 * A fenced block, and the news that there is more of it off to the right.
 *
 * A drawing too wide for the column scrolls, which is the right answer — it
 * stays sharp and nothing is resized underneath you. The problem is that you
 * cannot tell: this platform draws overlay scrollbars that stay invisible until
 * something touches them, so a diagram cut off at the edge and a diagram that
 * is genuinely broken look identical.
 *
 * So the edge says so, and only while it is true. Scrolled to the end, or never
 * over-wide to begin with, and there is nothing to see.
 */
function Block({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLPreElement>(null);
  const [more, setMore] = useState(false);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // A pixel of slack: fractional layout widths otherwise report an overflow
    // that is not there and leave the fade on permanently.
    setMore(el.scrollWidth - el.clientWidth - el.scrollLeft > 1);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    // The column changes width with the window, and the content changes on
    // every delta of a streaming turn.
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure, children]);

  return (
    <div className="relative mb-4 last:mb-0">
      <InPre value={true}>
        <pre
          ref={ref}
          onScroll={measure}
          className="ft-pre overflow-x-auto rounded-md border border-line-soft bg-panel px-4 py-3.5"
        >
          {children}
        </pre>
      </InPre>
      {more && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-px right-px w-10 rounded-r-md bg-gradient-to-l from-panel to-transparent"
        />
      )}
    </div>
  );
}

/**
 * A heading, flattened.
 *
 * An agent writes `##` for a section of a two-paragraph reply, so the six
 * levels of the format do not mean six sizes here — three is enough to show
 * structure without a chat message shouting.
 */
function Heading({ level, children }: { level: 1 | 2 | 3; children: React.ReactNode }) {
  const size = level === 1 ? "text-title" : level === 2 ? "text-body" : "text-body";
  return (
    <p className={`mt-5 mb-2 font-semibold text-bone first:mt-0 ${size} ${MEASURE}`}>
      {children}
    </p>
  );
}

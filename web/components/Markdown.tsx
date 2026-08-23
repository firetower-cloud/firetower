"use client";

import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

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
    <div className="ft-md text-[13.5px] leading-[1.6] text-text">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Paragraph spacing lives here rather than in a stylesheet so the
          // last one does not push the next item away.
          p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,

          h1: ({ children }) => <Heading level={1}>{children}</Heading>,
          h2: ({ children }) => <Heading level={2}>{children}</Heading>,
          h3: ({ children }) => <Heading level={3}>{children}</Heading>,
          h4: ({ children }) => <Heading level={3}>{children}</Heading>,
          h5: ({ children }) => <Heading level={3}>{children}</Heading>,
          h6: ({ children }) => <Heading level={3}>{children}</Heading>,

          ul: ({ children }) => (
            <ul className="mb-2 flex list-disc flex-col gap-0.5 pl-5 last:mb-0 marker:text-mute">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="mb-2 flex list-decimal flex-col gap-0.5 pl-5 last:mb-0 marker:text-mute">
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
              className="text-ember underline decoration-ember-deep underline-offset-2 hover:decoration-ember"
            >
              {children}
            </a>
          ),

          strong: ({ children }) => <strong className="font-semibold text-bone">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          del: ({ children }) => <del className="text-mute line-through">{children}</del>,

          blockquote: ({ children }) => (
            <blockquote className="mb-2 border-l-2 border-line pl-3 text-dim last:mb-0">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-3 border-line" />,

          code: ({ className, children }) => {
            // A fenced block gets a language class; an inline span does not.
            // That is the only thing distinguishing them here, and it holds
            // for an unclosed fence too — which is most of a streaming turn.
            const fenced = /language-/.test(className ?? "");
            if (!fenced) {
              // A chip rather than a tint. Agents write paths and symbols
              // inline constantly, and at this density a background alone does
              // not separate them from the sentence around them.
              return (
                <code className="rounded-[5px] border border-line bg-raise px-[5px] py-[1.5px] font-mono text-[11.5px] whitespace-nowrap text-bone">
                  {children}
                </code>
              );
            }
            return (
              <code className="block overflow-x-auto font-mono text-[12px] leading-[1.5] whitespace-pre">
                {children}
              </code>
            );
          },
          pre: ({ children }) => (
            <pre className="mb-2.5 overflow-x-auto rounded-[8px] border border-line bg-ground px-3 py-2.5 last:mb-0">
              {children}
            </pre>
          ),

          // Tables come from the GitHub extension, and an agent reaching for
          // one usually has something worth lining up.
          table: ({ children }) => (
            <div className="mb-2 overflow-x-auto last:mb-0">
              <table className="w-full border-collapse text-[12.5px]">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b border-line px-2 py-1 text-left font-medium text-dim">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-b border-line-soft px-2 py-1.5 align-top">{children}</td>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});

/**
 * A heading, flattened.
 *
 * An agent writes `##` for a section of a two-paragraph reply, so the six
 * levels of the format do not mean six sizes here — three is enough to show
 * structure without a chat message shouting.
 */
function Heading({ level, children }: { level: 1 | 2 | 3; children: React.ReactNode }) {
  const size = level === 1 ? "text-[15px]" : level === 2 ? "text-[14px]" : "text-[13.5px]";
  return (
    <p className={`mt-3 mb-1.5 font-semibold text-bone first:mt-0 ${size}`}>{children}</p>
  );
}

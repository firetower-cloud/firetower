import SessionView from "./SessionView";

/**
 * One shell, for every session there will ever be.
 *
 * A static export writes an HTML file per route and refuses a dynamic route it
 * cannot enumerate — and session ids are made at runtime, so there is nothing
 * to enumerate. The placeholder is the answer: the export writes
 * `sessions/_.html`, and the control plane serves it for any `/sessions/…`
 * path. The page then reads the real id out of the address bar.
 *
 * This file is a server component only because `generateStaticParams` cannot
 * live in a client one. Everything it renders is the client component beside
 * it.
 */
export function generateStaticParams() {
  return [{ id: "_" }];
}

export default function Page() {
  return <SessionView />;
}

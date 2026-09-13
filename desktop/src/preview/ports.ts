/**
 * Which ports are worth offering.
 *
 * Nothing on the control plane knows what is listening inside a session, but
 * the conversation usually does: a dev server prints its address, and the
 * agent repeats it. So the transcript is read for `localhost:3000`,
 * `:5173`, `port 8000` — newest first, with the line it came from as the
 * caption. The field beside them is for everything the transcript missed.
 */
import type { Item } from "@/src/api/conversation";

export type Suggested = { port: number; why: string };

const SEEN = /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})|\bport\s+(\d{2,5})\b|https?:\/\/[^\s/:]+:(\d{2,5})/gi;

export function suggestPorts(items: Item[]): Suggested[] {
  const found = new Map<number, string>();
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind !== "CommandExecution" && item.kind !== "AssistantMessage") continue;
    const text = `${item.output ?? ""}\n${item.text ?? ""}`;
    for (const m of text.matchAll(SEEN)) {
      const port = Number(m[1] ?? m[2] ?? m[3]);
      if (!port || port < 80 || port > 65535 || found.has(port)) continue;
      const line = text.slice(text.lastIndexOf("\n", m.index ?? 0) + 1).split("\n")[0].trim();
      found.set(port, line.length > 72 ? `${line.slice(0, 72)}…` : line);
    }
    if (found.size >= 6) break;
  }
  return [...found].map(([port, why]) => ({ port, why }));
}

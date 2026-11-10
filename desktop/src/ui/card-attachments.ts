/**
 * A card's attachments, brought into the workspace started from it.
 *
 * Somebody who files a bug on a Trello card pastes the screenshot onto the
 * card, and starting work from that card used to leave it behind: the agent
 * got the title and the link, and the picture it most needed was one more
 * thing to download and drop by hand. Now the files come along on their own,
 * and under exactly the rules a drop follows (`~/ui/attach`): the same caps,
 * the same refusal lines, the same chips. A picture rides in the first
 * message, anything else lands in the workspace.
 *
 * A link (a Google Doc, a Figma frame) has no bytes to bring. It is written
 * into the description instead, where the agent can follow it.
 *
 * The bytes come through Firetower rather than straight from Trello, because
 * Trello wants the credential even to download, and the credential never
 * leaves the server.
 */
import type { TaskAttachment } from "~/api/generated/model";
import { getGetTaskAttachmentUrl } from "~/api/generated/tasks/tasks";
import { apiBase, token } from "~/client/http";
import { BIGGEST_FILE, BIGGEST_IMAGE, megabytes, roomFor, size, type Chip } from "./attach";

/**
 * The kinds the server serves as images, and so the only ones the model can be
 * shown. HEIC, SVG and TIFF, common from a phone, are images to Trello but
 * would be refused as one, so they go into the workspace as files instead.
 */
const PICTURES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const picture = (a: TaskAttachment) => PICTURES.has(a.mime ?? "");

/**
 * The trackers whose tasks carry attachments, by a task's `source`.
 *
 * Asked before `/tasks/one` is, so starting from a GitHub issue does not
 * spend a request on a list that is always empty. Trello today; a tracker
 * that learns to list them joins here.
 */
const HOLDING = new Set(["trello"]);

export function holdsAttachments(source: string | undefined): boolean {
  return !!source && HOLDING.has(source);
}

/**
 * What a chip says when the server would not hand a file over: its own
 * sentence (a refused token, a file too big), or failing that, which file.
 */
export function refusalOf(body: string, name: string): string {
  try {
    const said = (JSON.parse(body) as { message?: unknown }).message;
    if (typeof said === "string" && said.trim()) return said;
  } catch {
    /* Not an answer of ours: a proxy's page, or nothing. */
  }
  return `${name} could not be brought from the card.`;
}

/**
 * Which files to bring, which links to write down, and what to say about the
 * rest.
 *
 * The size cap is decided from the size the card states, so a file the
 * composer would refuse is never downloaded only to be refused. One whose size
 * is not stated is brought, and is sifted like any file once it arrives. Then
 * the message's own cap, counting what `held` already takes.
 */
export function fromCard(
  list: TaskAttachment[],
  held: number,
): { files: TaskAttachment[]; links: TaskAttachment[]; refusals: string[] } {
  const refusals: string[] = [];
  const links = list.filter((a) => !a.upload);
  const sized = list.filter((a) => {
    if (!a.upload) return false;
    const cap = picture(a) ? BIGGEST_IMAGE : BIGGEST_FILE;
    if (a.bytes == null || a.bytes <= cap) return true;
    refusals.push(`${a.name} is over ${megabytes(cap)}.`);
    return false;
  });
  const room = roomFor(
    held,
    sized.map((a) => a.name),
  );
  refusals.push(...room.refusals);
  return { files: sized.slice(0, room.fit), links, refusals };
}

/** The chip an attachment shows while it is on its way. */
export function chipForAttachment(id: number, a: TaskAttachment): Chip {
  return {
    id,
    name: a.name,
    kind: picture(a) ? "image" : "file",
    size: a.bytes == null ? "" : size(a.bytes),
    pending: true,
  };
}

/**
 * The seeded body with the card's links under it.
 *
 * Named where the card names them, because "Checkout mockup" says more than a
 * Figma address. A link with no name of its own is written once, as itself.
 */
export function withLinks(body: string, links: TaskAttachment[]): string {
  if (links.length === 0) return body;
  const lines = links.map((l) => (l.name && l.name !== l.url ? `${l.name}: ${l.url}` : l.url));
  return `${body}\n\nLinks on the card:\n${lines.join("\n")}`;
}

/**
 * One attachment's bytes, as a `File` the composer can take.
 *
 * A plain `fetch` rather than the generated call, which reads every answer as
 * JSON. Named as the card says, and typed as the card says only for a
 * picture, so a picture is a picture whatever the download was served as and
 * nothing else is taken for one.
 */
export async function download(card: string, a: TaskAttachment): Promise<File> {
  const res = await fetch(`${apiBase()}${getGetTaskAttachmentUrl({ url: card, id: a.id })}`, {
    headers: { authorization: `Bearer ${token()}` },
  });
  if (!res.ok) throw new Error(refusalOf(await res.text().catch(() => ""), a.name));
  const blob = await res.blob();
  return new File([blob], a.name, { type: picture(a) ? a.mime! : blob.type });
}

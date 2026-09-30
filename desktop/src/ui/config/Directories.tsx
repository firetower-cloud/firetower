/**
 * Where things are filed, and so who can reach them.
 *
 * The one screen that answers "what does this directory hold, and who does it
 * let in" without opening a resource first. Until now the desktop could only
 * see a directory sideways — as a chip on something filed in it — so the
 * question "what is in Ledger work" had no place to be asked.
 *
 * Read and create. Renaming, granting and deleting are an administrator's and
 * stay on the web, because a grant is the organisation's decision and the
 * screen that makes it should be the one that shows every directory, including
 * the ones whose last administrator has left.
 */
import { useState } from "react";
import { ChevronDown, ChevronRight, FolderOpen } from "lucide-react";
import { Icon } from "~/components/ui";
import { useListGrants } from "~/api/generated/access/access";
import type { Directory } from "~/api/generated/model";
import { useDirectories } from "~/data";
import { Face } from "~/ui/PickPeople";
import { Rows, Section } from "~/ui/config/bits";

/** What a level is called on screen. `writer` is the wire's word for Editor. */
const said = (l: string | null | undefined) =>
  l === "viewer" ? "Viewer" : l === "writer" ? "Editor" : l === "admin" ? "Admin" : "—";

export function Directories() {
  const { data, loading, error } = useDirectories();

  return (
    <Section
      title="Directories"
      note="Anything filed in one belongs to it, and everybody it lets in can reach that. Moving something in hands it over."
    >
      <Rows feed={{ data, loading, error }} empty="No directories yet.">
        {data.map((d) => (
          <One key={d.id} directory={d as Directory} />
        ))}
      </Rows>
    </Section>
  );
}

function One({ directory }: { directory: Directory }) {
  const [open, setOpen] = useState(false);
  // Asked only once somebody opens it. Every directory's grants on arrival is
  // the shape of request this screen was reorganised to stop making.
  const { data: grants = [] } = useListGrants(directory.id, { query: { enabled: open } });

  const holds =
    directory.workspaces + directory.hosts + directory.agentAccounts + directory.secrets;

  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={`Who is in ${directory.name}`}
        className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left hover:bg-raise"
      >
        <span className="grid h-[21px] w-[21px] shrink-0 place-items-center rounded-full border border-line bg-overlay text-dim">
          <Icon of={FolderOpen} size={12} />
        </span>
        <span className="min-w-0 flex-1 truncate text-ui text-bone">
          {directory.name} <span className="font-mono text-micro text-mute">d/{directory.slug}</span>
        </span>
        <span className="shrink-0 text-micro text-mute">
          {holds === 0 ? "empty" : `${holds} ${holds === 1 ? "thing" : "things"}`}
        </span>
        {directory.level && <span className="shrink-0 text-meta text-dim">{said(directory.level)}</span>}
        <Icon of={open ? ChevronDown : ChevronRight} size={12} />
      </button>

      {open &&
        (grants.length === 0 ? (
          <p className="py-1.5 pr-3.5 pl-9 text-micro text-mute">Nobody has been let in yet.</p>
        ) : (
          grants.map((g) => (
            <div key={g.subjectId} className="flex items-center gap-2.5 py-1.5 pr-3.5 pl-9">
              <Face
                who={{ name: g.subjectName, kind: g.subjectKind === "team" ? "team" : "person" }}
              />
              <span className="min-w-0 flex-1 truncate text-ui text-text">{g.subjectName}</span>
              <span className="shrink-0 text-meta text-dim">{said(g.level)}</span>
            </div>
          ))
        ))}
    </>
  );
}

/**
 * One Add button, and a menu of the two ways in.
 *
 * **Two primary buttons side by side is a question, not an offer.** "Connect
 * a server" and "Add a skill" sat next to each other at equal weight, so the
 * header asked somebody to classify what they had before they could start.
 * One button says the thing they came to do; the menu says which kind.
 */
import { useState } from "react";
import { ChevronDown, Link2, Upload } from "lucide-react";
import { MenuItem } from "~/components/ui";
import { Pop } from "~/ui/Pop";

export function AddMenu({
  onUpload,
  onConnect,
}: {
  onUpload: () => void;
  onConnect: () => void;
}) {
  const [at, setAt] = useState<HTMLElement | null>(null);
  return (
    <div>
      <button
        type="button"
        className="btn primary"
        aria-haspopup="menu"
        aria-expanded={at !== null}
        onClick={(e) => setAt(at ? null : e.currentTarget)}
      >
        Add
        <ChevronDown className="h-4 w-4" strokeWidth={1.75} />
      </button>
      {at && (
        <Pop anchor={at} onClose={() => setAt(null)}>
          <div className="w-56 py-1">
            <MenuItem
              onClick={() => {
                setAt(null);
                onUpload();
              }}
            >
              <span className="flex items-center gap-2.5">
                <Upload className="h-4 w-4 text-dim" strokeWidth={1.5} />
                Upload skills
              </span>
            </MenuItem>
            <MenuItem
              onClick={() => {
                setAt(null);
                onConnect();
              }}
            >
              <span className="flex items-center gap-2.5">
                <Link2 className="h-4 w-4 text-dim" strokeWidth={1.5} />
                Connect a custom MCP
              </span>
            </MenuItem>
          </div>
        </Pop>
      )}
    </div>
  );
}

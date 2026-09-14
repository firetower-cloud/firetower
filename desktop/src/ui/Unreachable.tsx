/**
 * The state the memo expects to be the common one.
 *
 * Written as a fact and an action, not an apology: the work is fine, it is the
 * route that is missing, and the person can do something about it.
 */
import { CircleSlash2 } from "lucide-react";

export function Unreachable({ org }: { org: string }) {
  return (
    <div className="grid flex-1 place-items-center bg-ground">
      <div className="max-w-[22rem] text-center">
        <CircleSlash2 className="mx-auto h-7 w-7 text-mute" strokeWidth={1.5} />
        <h2 className="mt-4 text-title text-bone">No route to {org}</h2>
        <p className="mt-2 text-read text-dim">
          The agents are still running on their machines. This Mac just can’t reach the control
          plane — usually the VPN.
        </p>
        <button className="control mt-5 border border-line bg-raise text-bone hover:bg-overlay">
          Open Tailscale
        </button>
      </div>
    </div>
  );
}

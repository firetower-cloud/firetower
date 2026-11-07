/**
 * Who you are, which Firetower you are in, and how the app looks.
 *
 * Under the avatar at the foot of the rail, which is where the Firetower
 * switcher moved to when `ServerStrip.tsx` went. The strip cost a permanent
 * 48px of vertical chrome to answer a question that is asked a few times a
 * day, and it made every screen slightly about fleet management.
 *
 * **One ember dot, and only here.** It means *an agent is waiting on you in a
 * Firetower you are not in* — the one thing leaving this screen would
 * otherwise lose. The count across every connected Firetower is unchanged and
 * still goes to the dock and to the island; this is the narrower, cheaper
 * thing that was added back inside the window.
 *
 * `Fleet.tsx`'s headline and its grouping survive here, in the switch list.
 */
import { useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  CircleFadingArrowUp,
  KeyRound,
  LogOut,
  Moon,
  Plus,
  Settings2,
  Sun,
  BookOpen,
} from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { Icon, Segmented } from "~/components/ui";
import { useLogout, useMe } from "~/api/generated/auth/auth";
import { dropCache } from "~/backend";
import { useFleet, waitingIn, type Backend } from "~/fleet";
import { forget } from "~/servers";
import { key } from "~/platform";
import { navigate } from "~/shims/next-navigation";
import { useTheme, type Theme } from "~/theme";
import { useConfirm } from "~/ui/Confirm";
import { Pop } from "~/ui/Pop";

type Page = "profile" | "switch";

export function ProfileMenu({
  backend,
  waitingElsewhere,
  onSwitch,
  onForgot,
}: {
  backend: Backend;
  waitingElsewhere: boolean;
  /** Which Firetower the window is in. Owned by `App`, because the whole
   *  backend provider is keyed on it. */
  onSwitch: (serverId: string) => void;
  onForgot: () => void;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [page, setPage] = useState<Page>("profile");
  const me = useMe();
  const who = me.data?.user?.username ?? backend.user;

  const open = (el: HTMLElement) => {
    setPage("profile");
    setAnchor((held) => (held ? null : el));
  };

  return (
    <>
      <button
        onClick={(e) => open(e.currentTarget)}
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        title={`${who} — ${backend.org}${waitingElsewhere ? " · someone is waiting elsewhere" : ""}`}
        aria-label="You, and which Firetower you are in"
        className="group relative grid h-10 w-10 shrink-0 place-items-center rounded-full"
      >
        <span
          className={`grid h-[30px] w-[30px] place-items-center rounded-full text-meta font-mid tracking-wide transition-colors ${
            anchor ? "bg-panel text-bone" : "bg-raise text-dim group-hover:text-bone"
          } shadow-(--shadow-raise)`}
        >
          {initials(who)}
        </span>
        {waitingElsewhere && (
          <span className="pointer-events-none absolute top-0.5 right-0.5 h-2 w-2 rounded-full bg-ember ring-2 ring-ground" />
        )}
      </button>

      {anchor && (
        <Pop anchor={anchor} onClose={() => setAnchor(null)} beside width={page === "switch" ? 296 : 252}>
          {page === "profile" ? (
            <Profile backend={backend} who={who} elsewhere={waitingElsewhere} onSwitch={() => setPage("switch")} onClose={() => setAnchor(null)} onForgot={onForgot} />
          ) : (
            <FiretowerSwitcher backend={backend} onSwitch={onSwitch} onBack={() => setPage("profile")} onClose={() => setAnchor(null)} />
          )}
        </Pop>
      )}
    </>
  );
}

/**
 * Initials from a username.
 *
 * One letter where there is only one word, two where the name says so —
 * `kevin` is "K" and `kevin.piacentini` is "KP". Never more: this is a 30px
 * circle and a third letter is the point at which it stops being read and
 * starts being decoded.
 */
export function initials(username: string): string {
  const parts = username.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 1).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function Profile({
  backend,
  who,
  elsewhere,
  onSwitch,
  onClose,
  onForgot,
}: {
  backend: Backend;
  who: string;
  elsewhere: boolean;
  onSwitch: () => void;
  onClose: () => void;
  onForgot: () => void;
}) {
  const me = useMe();
  const confirm = useConfirm();
  const logout = useLogout();
  const fleet = useFleet();
  const [choice, resolved, setChoice] = useTheme();

  const leave = useMutation({
    mutationFn: async () => {
      await logout.mutateAsync(undefined as never).catch(() => {});
      forget(backend.id);
      dropCache(backend.id);
    },
    onSuccess: onForgot,
  });

  const go = (to: string) => {
    onClose();
    navigate(to);
  };

  return (
    <>
      <div className="px-2.5 pt-2 pb-1.5">
        <p className="truncate text-ui text-bone">{who}</p>
        <p className="truncate text-meta text-mute">{me.data?.user?.email ?? backend.url.replace(/^https?:\/\//, "")}</p>
      </div>
      <Rule />

      <button onClick={onSwitch} className="mrow">
        <span className="server-mark grid h-6 w-6 shrink-0 place-items-center text-micro" data-reach={backend.reach}>
          {backend.mark}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-bone">Switch Firetower</span>
          <span className="block truncate text-meta text-mute">
            In {backend.org} · {fleet.length} connected
          </span>
        </span>
        {elsewhere && <span className="h-2 w-2 shrink-0 rounded-full bg-ember" title="Waiting somewhere you are not" />}
        <span className="shrink-0 text-mute">
          <Icon of={ChevronRight} size={14} />
        </span>
      </button>

      <Rule />
      <Item icon={KeyRound} label="Account" onPick={() => go("/account")} />
      <Item icon={Settings2} label="Settings" hint={key(",")} onPick={() => go("/configuration/people")} />
      <Item icon={CircleFadingArrowUp} label="Updates" onPick={() => go("/updates")} />
      {import.meta.env.DEV && <Item icon={BookOpen} label="Style guide" onPick={() => go("/style")} />}

      <Rule />
      {/* Appearance. Three choices rather than the two the artifact draws:
          **System is the default**, and it is the one that cannot be inferred
          from the other two — a window still in light at midnight is the bug
          a light theme ships with if nobody offers it.

          Two lines rather than one, because all three want a word. "System"
          as an icon alone is a choice nobody can name, and the whole point of
          it is that it is the one you do not have to think about. */}
      <div className="px-2.5 pt-1.5 pb-2">
        <p className="flex items-center gap-2.5">
          <span className="shrink-0 text-mute">
            <Icon of={resolved === "light" ? Sun : Moon} size={16} />
          </span>
          <span className="min-w-0 flex-1 truncate">Appearance</span>
        </p>
        {/* `Segmented`, not a third copy of it. This was a hand-rolled
            `.track` beside the component that exists for it, which is why it
            drifted far enough for somebody to notice. */}
        <Segmented
          className="mt-1.5 ml-[26px] flex"
          label="Appearance"
          value={choice}
          onChange={setChoice}
          options={[
            ["system", "System", `Follow the Mac — ${resolved} right now`],
            ["light", "Light"],
            ["dark", "Dark"],
          ] as const}
        />
      </div>

      <Rule />
      <Item
        icon={LogOut}
        label={`Sign out of ${backend.org}`}
        tone="danger"
        onPick={() =>
          void confirm({
            title: `Sign out of ${backend.org}?`,
            body: "This Mac's token is revoked on the server. The sessions carry on; you can sign in again with your password.",
            action: "Sign out",
            tone: "danger",
          }).then((ok) => ok && leave.mutate())
        }
      />
    </>
  );
}

/**
 * Every connected Firetower, with what is true of it.
 *
 * **Unreachable is dimmed and dashed, never red.** Red is brick and means
 * something failed; a Firetower behind a VPN that is off has not failed, and
 * the memo expects that to be the common case. Its row stays, with what was
 * last known on it — a list that empties itself reads as work being lost.
 */
export function FiretowerSwitcher({
  backend,
  onSwitch,
  onBack,
  onClose,
}: {
  /** Null from the title bar before a Firetower has resolved. */
  backend: Backend | null;
  onSwitch: (serverId: string) => void;
  /** Absent when this is the whole menu rather than its second page. */
  onBack?: () => void;
  onClose: () => void;
}) {
  const fleet = useFleet();

  return (
    <>
      {onBack && (
        <>
          <button onClick={onBack} className="mrow text-dim">
            <span className="shrink-0">
              <Icon of={ChevronLeft} size={14} />
            </span>
            <span className="min-w-0 flex-1 truncate">Switch Firetower</span>
          </button>
          <Rule />
        </>
      )}

      {fleet.map(({ backend: b, sessions }) => {
        const dark = b.reach === "unreachable";
        const waiting = waitingIn(sessions);
        const working = sessions.filter((s) => s.status === "Working" || s.status === "Starting").length;
        return (
          <button
            key={b.id}
            onClick={() => {
              onClose();
              onSwitch(b.id);
            }}
            className={`mrow items-start py-2 ${dark ? "stale" : ""}`}
          >
            <span className="server-mark mt-px grid h-[26px] w-[26px] shrink-0 place-items-center text-micro" data-reach={b.reach}>
              {b.mark}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-bone">
                {b.org}
                {b.id === backend?.id && <span className="text-mute"> — you are here</span>}
              </span>
              <span className="block truncate text-meta text-mute">
                {dark ? (working > 0 ? `can’t reach it — ${working} running, last known` : "can’t reach it — last known") : b.user}
              </span>
            </span>
            {dark ? null : waiting > 0 ? (
              <span className="mt-1 flex shrink-0 items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-ember" />
                <span className="text-meta text-text">{waiting}</span>
              </span>
            ) : (
              <span className="mt-1 shrink-0 text-meta whitespace-nowrap text-mute">{working} working</span>
            )}
          </button>
        );
      })}

      <Rule />
      <button
        onClick={() => {
          onClose();
          navigate("/connect");
        }}
        className="mrow"
      >
        <span className="shrink-0 text-mute">
          <Icon of={Plus} size={16} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-bone">Connect a Firetower…</span>
          <span className="block truncate text-meta text-mute">An address, and the account you have there.</span>
        </span>
      </button>
    </>
  );
}

function Rule() {
  return <div className="mx-2.5 my-1.5 h-px bg-line" />;
}

function Item({
  icon,
  label,
  hint,
  tone,
  onPick,
}: {
  icon: typeof KeyRound;
  label: string;
  hint?: string;
  tone?: "danger";
  onPick: () => void;
}) {
  return (
    <button onClick={onPick} className={`mrow ${tone === "danger" ? "text-brick" : ""}`}>
      <span className={`shrink-0 ${tone === "danger" ? "text-brick" : "text-mute"}`}>
        <Icon of={icon} size={16} />
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && <span className="shrink-0 text-micro text-mute">{hint}</span>}
    </button>
  );
}

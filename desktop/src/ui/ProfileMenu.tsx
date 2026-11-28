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
 * ## Served in a browser, the menu is its first page and the avatar has one mark
 *
 * There is one Firetower behind a page a control plane served — it is the
 * origin the page came from — so the second page, the row that opens it and
 * the mark beside that row are all answers to a question that cannot be
 * asked. The ember dot goes with them for the same reason and not a different
 * one: *waiting somewhere you are not* needs an elsewhere, and there is none.
 *
 * **What is left is one mark, and it is `.news`.** That is the specification's
 * F4 — "one of the two marks the avatar can draw" — and it is the right one of
 * the two: a deployment with an upgrade waiting is just as real in a browser,
 * and `Updates` still offers it. What a browser cannot light it with is *this
 * app's own build*, which `update.ts` already settles by never checking
 * outside a shell, so `updatesRow`'s two trains come down to one without this
 * file doing anything about it. See `~/installed-app`.
 *
 * ## Two marks on the avatar, and exactly two things that may set them
 *
 * Settings and Updates used to be icons in the rail as well as rows in here,
 * and the rail's Updates icon is where the *a newer build is out* mark lived.
 * The icons have gone — `destinations.ts` says why — so the mark comes here,
 * because the menu it belongs to hangs off this button and a signal has to be
 * readable without opening the thing it is about.
 *
 * | mark | where | means | token |
 * |---|---|---|---|
 * | ember dot | top right | an agent is waiting on you somewhere you are not | `--color-ember` |
 * | `.news` | bottom right | **an available update, and nothing else** | `--color-text` |
 *
 * **Each mark means one thing, and that is the whole constraint.** A dot that
 * can mean several things means nothing: you cannot act on it, so you learn to
 * ignore it. So nothing else may dot this avatar — not a run already going, not
 * a failed update check, not an unread release note. If something new deserves
 * to be seen from here, it gets its own row in the menu and the row says what
 * it is; the marks stay at two. `updatesRow` holds the Updates half of that
 * rule, which is why `dot` there is not the same boolean as "worth knowing".
 *
 * They are drawn apart and in different colours because they are different
 * facts. Ember is reserved for *an agent is waiting on you*, and a newer build
 * is not that — which is the reasoning `.news` was given in the stylesheet when
 * it was the rail's, kept whole.
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
  Monitor,
  Moon,
  Plus,
  Settings2,
  Smartphone,
  Sun,
  BookOpen,
} from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import { Icon, Segmented } from "~/components/ui";
import { useLogout, useMe } from "~/api/generated/auth/auth";
import { dropCache } from "~/backend";
import { useUpdatesRow } from "~/data";
import { useFleet, waitingIn, type Backend } from "~/fleet";
import { forget } from "~/servers";
import { advertisedKey, installedApp } from "~/installed-app";
import { navigate } from "~/shims/next-navigation";
import { useTheme, type Theme } from "~/theme";
import { SETTINGS_HOME } from "~/ui/config/panes";
import { useConfirm } from "~/ui/Confirm";
import { GetTheMobileApp } from "~/ui/GetTheMobileApp";
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
  /* Here rather than in `Profile`, because the popover unmounts when the
     dialog takes the pointer and the avatar does not. The same reason `page`
     is held here: what the menu opens outlives the menu. */
  const [gettingTheApp, setGettingTheApp] = useState(false);
  const me = useMe();
  const who = me.data?.user?.username ?? backend.user;
  /* Read here rather than in the rail, which asked for it only while it drew
     the Updates door. One read for both halves of the signal — the mark on
     this button and the row inside the menu have to agree, and two calls could
     straddle a refetch and disagree for a frame. */
  const updates = useUpdatesRow();
  /* An elsewhere to be waited on in needs more than one Firetower, which a
     served page never has. Read here rather than in `Rail`, which computes the
     fact: the fact is still true of the fleet, and what changes is whether
     this avatar has anywhere to put it. */
  const elsewhere = waitingElsewhere && installedApp();

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
        title={`${who} — ${backend.org}${elsewhere ? " · someone is waiting elsewhere" : ""}${updates.dot ? ` · ${updates.label}` : ""}`}
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
        {elsewhere && (
          <span className="pointer-events-none absolute top-0.5 right-0.5 h-2 w-2 rounded-full bg-ember ring-2 ring-ground" />
        )}
        {/* Bottom right, and never ember: the two marks have to stay tellable
            apart at a glance, because they want different things of you. */}
        {updates.dot && <span className="news pointer-events-none bottom-0.5 right-0.5" title={updates.label} />}
      </button>

      {anchor && (
        <Pop anchor={anchor} onClose={() => setAnchor(null)} beside width={page === "switch" ? 296 : 252}>
          {page === "profile" ? (
            <Profile
              backend={backend}
              who={who}
              elsewhere={elsewhere}
              updates={updates}
              onSwitch={() => setPage("switch")}
              onGetTheApp={() => {
                setAnchor(null);
                setGettingTheApp(true);
              }}
              onClose={() => setAnchor(null)}
              onForgot={onForgot}
            />
          ) : (
            <FiretowerSwitcher backend={backend} onSwitch={onSwitch} onBack={() => setPage("profile")} onClose={() => setAnchor(null)} />
          )}
        </Pop>
      )}

      {/* `backend.url` rather than `window.location.origin`: in a browser
          `probe.ts` has already resolved the two to the same thing, and in the
          installed app this is the Firetower the window is on. One read is
          correct in both clients. */}
      {gettingTheApp && <GetTheMobileApp address={backend.url} onClose={() => setGettingTheApp(false)} />}
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

/**
 * The menu's first page, which in a browser is the whole menu.
 *
 * Exported for `installed-only.test.tsx`, which renders it on both sides of
 * the shell question. It is only drawn inside the popover above, so a static
 * render of `ProfileMenu` reaches the avatar and nothing under it — and the
 * row this change takes away is in here.
 */
export function Profile({
  backend,
  who,
  elsewhere,
  updates,
  onSwitch,
  onGetTheApp,
  onClose,
  onForgot,
}: {
  backend: Backend;
  who: string;
  elsewhere: boolean;
  /** What the avatar's `.news` mark is about, in words. */
  updates: { label: string; dot: boolean };
  onSwitch: () => void;
  /** The dialog is `ProfileMenu`'s, not this page's — the popover goes when
   *  it opens. Threaded exactly as `onSwitch` is. */
  onGetTheApp: () => void;
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

      {/* **The door to the second page, and the only one.** Gone in a browser
          with the page behind it: `onSwitch` is the only thing that sets
          `page`, so taking this away is what makes `page === "switch"`
          unreachable rather than a branch left hanging. The popover's width
          follows — it is 252 on this page and only widens to 296 for the
          switcher. */}
      {installedApp() && (
        <>
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
        </>
      )}
      <Item icon={KeyRound} label="Account" onPick={() => go("/account")} />
      {/* The only Settings there is, and the only place ⌘, is advertised.
          `SETTINGS_HOME` rather than the path, so this row, the key and the
          palette's command cannot drift to three different panes. */}
      <Item icon={Settings2} label="Settings" hint={advertisedKey(",")} onPick={() => go(SETTINGS_HOME)} />
      {/* The row says which version; the mark on the avatar only says there is
          one. Neither is enough alone — a number nobody can see until they
          open a menu is not a signal, and a dot you cannot act on is noise. */}
      <Item icon={CircleFadingArrowUp} label={updates.label} onPick={() => go("/updates")} />
      {/* **Last in this group, and under Updates rather than above it.**
          *Updates* is not *where you go*; it is *which version of this
          software is running, and how to get a newer one* — which is why it
          carries a version in its own label and why the avatar above it draws
          `.news`. Account is *your standing here*, Settings is *how this
          deployment is set up*. So the three under the first rule are already
          one thing — the software, and your standing in it — and this is that
          same question asked about a different device. No new rule: a fifth
          hairline in a 252px popover would be furniture arguing with the thing
          it separates.

          Under rather than above, because Updates has to stay adjacent to the
          mark that explains it, and because the two rows about obtaining
          software then end up together.

          **In both clients, ungated, and with no keycap.** Everything
          `installedApp()` hides falls out of one of its two sentences — the
          window, or there being several Firetowers. This falls out of
          neither: it is a fact about a third device, and a browser can do it
          exactly as well as a window can. Better, arguably — the person
          reading a served page is the one who has not got the apps yet. So
          there is no `advertisedKey` here and nothing for a browser to take
          away.

          **And it never takes a mark**, in any state, for any reason. This
          file's rule is that exactly two things may dot the avatar; a new APK
          is not one of them and must not become one. */}
      <Item
        icon={Smartphone}
        label="Get the mobile app"
        testid="profile-get-the-mobile-app"
        onPick={onGetTheApp}
      />
      {/* A product row before a development one, so a dev build and a shipped
          build have the same menu down to the last product row. */}
      {import.meta.env.DEV && <Item icon={BookOpen} label="Style guide" onPick={() => go("/style")} />}

      <Rule />
      {/* Appearance. Three choices rather than the two the artifact draws:
          **System is the default**, and it is the one that cannot be inferred
          from the other two — a window still in light at midnight is the bug
          a light theme ships with if nobody offers it.

          **One row, and icons rather than words.** It used to be two lines
          because all three wanted a word, and that read as a form in the
          middle of a menu; the user asked for something lighter. A monitor,
          a sun and a moon is the switch most apps already use, so the
          glyphs carry it, and the words are still each segment's name and
          tooltip. System keeps its place and its explanation on hover. */}
      <div className="flex items-center gap-2.5 px-2.5 py-1.5">
        <span className="shrink-0 text-mute">
          <Icon of={resolved === "light" ? Sun : Moon} size={16} />
        </span>
        <span className="min-w-0 flex-1 truncate">Appearance</span>
        {/* `Segmented`, not a third copy of it. This was a hand-rolled
            `.track` beside the component that exists for it, which is why it
            drifted far enough for somebody to notice. */}
        <Segmented
          label="Appearance"
          value={choice}
          onChange={setChoice}
          options={[
            ["system", "System", `System — follows the Mac, ${resolved} right now`, Monitor],
            ["light", "Light", undefined, Sun],
            ["dark", "Dark", undefined, Moon],
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
            body: "This sign-in is revoked on the server. The sessions carry on; you can sign in again with your password.",
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
  testid,
  onPick,
}: {
  icon: typeof KeyRound;
  label: string;
  hint?: string;
  tone?: "danger";
  /** For a row a design contract names by id. */
  testid?: string;
  onPick: () => void;
}) {
  return (
    <button onClick={onPick} data-testid={testid} className={`mrow ${tone === "danger" ? "text-brick" : ""}`}>
      <span className={`shrink-0 ${tone === "danger" ? "text-brick" : "text-mute"}`}>
        <Icon of={icon} size={16} />
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && <span className="shrink-0 text-micro text-mute">{hint}</span>}
    </button>
  );
}

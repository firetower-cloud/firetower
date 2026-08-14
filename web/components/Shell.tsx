"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Mark, Signal } from "./Signal";
import { useListHosts } from "@/src/api/generated/hosts/hosts";
import { useListSessions } from "@/src/api/generated/sessions/sessions";
import { elapsed, inFlight, minutesSince, needsYou } from "@/src/api/view";

const NAV = [
  {
    href: "/",
    label: "Sessions",
    icon: (
      <>
        <path d="M2 3.5h10M2 7h10M2 10.5h6" strokeWidth="1.3" strokeLinecap="round" />
      </>
    ),
  },
  {
    href: "/repos",
    label: "Repositories",
    icon: (
      <>
        <circle cx="4" cy="3.5" r="1.6" strokeWidth="1.3" />
        <circle cx="4" cy="10.5" r="1.6" strokeWidth="1.3" />
        <circle cx="10.5" cy="3.5" r="1.6" strokeWidth="1.3" />
        <path d="M4 5.1v3.8M10.5 5.1v1.2c0 1.4-1.1 2.2-2.4 2.2H5.6" strokeWidth="1.3" strokeLinecap="round" />
      </>
    ),
  },
  {
    href: "/agents",
    label: "Agents",
    icon: (
      <>
        <path d="M7 1.8l4.6 2.4v3.2c0 2.4-1.9 4.2-4.6 5-2.7-.8-4.6-2.6-4.6-5V4.2z" strokeWidth="1.3" strokeLinejoin="round" />
        <circle cx="7" cy="6.4" r="1.2" strokeWidth="1.2" />
        <path d="M7 7.6v1.6" strokeWidth="1.2" strokeLinecap="round" />
      </>
    ),
  },
  {
    href: "/secrets",
    label: "Secrets",
    icon: (
      <>
        <rect x="2.8" y="6.2" width="8.4" height="6" rx="1.2" strokeWidth="1.3" />
        <path d="M4.8 6.2V4.4a2.2 2.2 0 014.4 0v1.8" strokeWidth="1.3" strokeLinecap="round" />
      </>
    ),
  },
  {
    href: "/compute",
    label: "Compute",
    icon: (
      <>
        <rect x="1.8" y="2.2" width="10.4" height="4" rx="1" strokeWidth="1.3" />
        <rect x="1.8" y="7.8" width="10.4" height="4" rx="1" strokeWidth="1.3" />
        <path d="M4 4.2h.01M4 9.8h.01" strokeWidth="1.6" strokeLinecap="round" />
      </>
    ),
  },
  {
    href: "/mobile",
    label: "On your phone",
    icon: (
      <>
        <rect x="3.5" y="1.5" width="7" height="11" rx="1.4" strokeWidth="1.3" />
        <path d="M6.4 10.6h1.2" strokeWidth="1.3" strokeLinecap="round" />
      </>
    ),
  },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const { data: sessions = [] } = useListSessions();
  const { data: hosts = [] } = useListHosts();

  /* Onboarding runs full-bleed — no fleet to navigate yet. */
  if (path.startsWith("/setup")) return <>{children}</>;

  // Anything still alive, with what needs you first.
  const pinned = sessions
    .filter((s) => needsYou(s) || inFlight(s))
    .sort((a, b) => Number(needsYou(b)) - Number(needsYou(a)));

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-[224px] shrink-0 flex-col border-r border-line bg-panel md:flex">
        <div className="flex items-center gap-2.5 px-4 pt-4 pb-5">
          <span className="text-bone">
            <Mark size={22} />
          </span>
          <span className="font-narrow text-[13px] font-semibold tracking-[0.22em] text-bone uppercase">
            Firetower
          </span>
        </div>

        <nav className="flex flex-col gap-px px-2">
          {NAV.map((n) => {
            const on = n.href === "/" ? path === "/" || path.startsWith("/sessions") : path === n.href;
            return (
              <Link
                key={n.href}
                href={n.href}
                className={`group flex items-center gap-2.5 rounded-[5px] px-2 py-[7px] text-[13px] transition-colors ${
                  on ? "bg-raise text-bone" : "text-dim hover:bg-raise/60 hover:text-text"
                }`}
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" className="opacity-70">
                  {n.icon}
                </svg>
                {n.label}
              </Link>
            );
          })}
        </nav>

        <div className="mt-7 px-4">
          <div className="eyebrow">In flight</div>
        </div>
        <div className="mt-2 flex-1 overflow-y-auto px-2 pb-4">
          {pinned.length === 0 && (
            <p className="px-2 py-1 text-[12px] text-mute">Nothing running.</p>
          )}
          {pinned.map((t) => {
            const on = path === `/sessions/${t.id}`;
            return (
              <Link
                key={t.id}
                href={`/sessions/${t.id}`}
                className={`flex items-center gap-1.5 rounded-[5px] py-[6px] pr-2 pl-1 transition-colors ${
                  on ? "bg-raise" : "hover:bg-raise/60"
                }`}
              >
                <Signal status={t.status} size={6} />
                <span className={`flex-1 truncate text-[12.5px] ${on ? "text-bone" : "text-dim"}`}>
                  {t.title}
                </span>
                <span className="font-mono text-[10px] text-mute">{elapsed(minutesSince(t.createdAt))}</span>
              </Link>
            );
          })}
        </div>

        <div className="border-t border-line px-4 py-3">
          <div className="eyebrow mb-2">Hosts</div>
          {hosts.map((h) => (
            <div key={h.name} className="flex items-center gap-2 py-[3px]">
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  h.state === "Online" ? "bg-sage" : "border border-mute"
                }`}
              />
              <span className="font-mono text-[11px] text-dim">{h.name}</span>
              <span className="ml-auto font-mono text-[10px] text-mute">
                {h.cpus ?? "—"}
              </span>
            </div>
          ))}
        </div>
      </aside>

      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}

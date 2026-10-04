"use client";

/**
 * The organisation, as one place with three rooms.
 *
 * People, teams and access were three cards stacked on one page, which made
 * them read as three settings rather than three subjects — and the longest of
 * them pushed the other two below the fold on any real installation.
 *
 * The tabs are not all the same audience, and that is deliberate rather than
 * untidy. **People and teams are an administrator's**: who can sign in and who
 * is in which group are facts about the organisation. **Access is everybody's**,
 * because sharing your own work is the reason it exists, and a member who has
 * to ask somebody else to share it will not share it.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMe } from "@/src/api/generated/auth/auth";
import { PageHead } from "@/components/ui";

const TABS = [
  {
    href: "/organization/people",
    label: "People",
    admin: true,
    says: "Who can sign in, and what each of them is.",
  },
  {
    href: "/organization/teams",
    label: "Teams",
    admin: true,
    says: "Groups to hand access to, so it is not handed out one person at a time.",
  },
  {
    href: "/organization/access",
    label: "Access",
    says: "Directories, what is filed in them, and who can see into them.",
  },
  {
    href: "/organization/settings",
    label: "Settings",
    admin: true,
    says: "What this organisation is, rather than who is in it.",
  },
];

export default function OrganizationLayout({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const { data: me } = useMe();
  const admin = me?.user.role === "admin";
  const tabs = TABS.filter((t) => !t.admin || admin);

  return (
    <div className="mx-auto max-w-[68rem] px-6 py-8">
      {/* The line under the name is the room's, not the section's. One
          sentence for all four said nothing about any of them — and on
          Settings it described the other three. */}
      <PageHead eyebrow="Organisation" title={me?.organization?.name || "Firetower"}>
        {tabs.find((t) => path.startsWith(t.href))?.says}
      </PageHead>

      {/* One row of tabs, underlined rather than boxed: they are where you are
          in a section, not a control you operate. */}
      <nav className="mb-5 flex items-center gap-1 border-b border-line">
        {tabs.map((t) => {
          const on = path === t.href;
          return (
            <Link
              key={t.href}
              href={t.href}
              className={`-mb-px border-b px-3 py-2 text-ui transition-colors duration-150 ${
                on
                  ? "border-bone text-bone"
                  : "border-transparent text-dim hover:text-text"
              }`}
            >
              {t.label}
            </Link>
          );
        })}
      </nav>

      {children}
    </div>
  );
}

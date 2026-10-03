"use client";

/**
 * The section has no page of its own — it has three.
 *
 * A client-side replace rather than a server redirect, because the interface is
 * a static export and there is no server to do it. `replace`, not `push`, so
 * Back leaves the section instead of bouncing off this again.
 *
 * Which of the three depends on who is asking: two of them are an
 * administrator's, and sending a member to a page that refuses them is a worse
 * greeting than sending them to the one they came for.
 */
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useMe } from "@/src/api/generated/auth/auth";

export default function OrganizationPage() {
  const router = useRouter();
  const { data: me, isPending } = useMe();

  useEffect(() => {
    if (isPending) return;
    router.replace(me?.user.role === "admin" ? "/organization/people" : "/organization/access");
  }, [router, me, isPending]);

  return null;
}

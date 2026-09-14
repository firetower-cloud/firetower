"use client";

/**
 * Your own account: the password, and the way out.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useChangePassword, useLogout, useMe } from "@/src/api/generated/auth/auth";
import { ApiError, forgetToken, rememberToken } from "@/src/api/http";
import { Button } from "@/components/ui/Button";
import { Card, CardHead } from "@/components/ui/Card";
import { Input } from "@/components/ui/Field";

export function Account() {
  const router = useRouter();
  const { data: me } = useMe();
  const change = useChangePassword();
  const logout = useLogout();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [done, setDone] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);

  const rotate = () => {
    setTrouble(null);
    if (next !== again) return setTrouble("The two new passwords differ.");
    change.mutate(
      { data: { current, new: next } },
      {
        onSuccess: ({ token }) => {
          // Every other session ended; this one carries on with the new token.
          rememberToken(token);
          setCurrent("");
          setNext("");
          setAgain("");
          setDone(true);
        },
        onError: (e) => setTrouble(e instanceof ApiError ? e.message : "That didn't work."),
      },
    );
  };

  return (
    <div className="mx-auto max-w-[640px] px-6 py-8">
      <h1 className="text-display text-bone">Account</h1>
      <p className="mt-2 text-ui text-dim">
        Signed in as <span className="font-mono text-text">{me?.user.username ?? "…"}</span>
        {me?.user.role === "admin" ? ", an administrator" : ""}
        {me?.organization ? <> of <span className="text-text">{me.organization.name}</span></> : null}.
      </p>

      <Card className="mt-7">
        <CardHead note={<span className="text-meta text-mute">Changing it signs every other browser and app out.</span>}><span className="text-ui text-bone">Password</span></CardHead>
        <div className="flex max-w-[24rem] flex-col gap-2 px-4 py-4">
          <Input type="password" value={current} onChange={(v) => setCurrent(v)} placeholder="Current password" autoComplete="current-password" />
          <Input type="password" value={next} onChange={(v) => setNext(v)} placeholder="New password" autoComplete="new-password" />
          <Input type="password" value={again} onChange={(v) => setAgain(v)} placeholder="New password, again" autoComplete="new-password" onKeyDown={(e) => e.key === "Enter" && rotate()} />
          <div className="flex items-center gap-3">
            <Button disabled={!current || !next || change.isPending} onClick={rotate}>
              {change.isPending ? "Changing…" : "Change password"}
            </Button>
            {done && <span className="text-meta text-sage">Changed.</span>}
            {trouble && <span className="text-meta text-brick">{trouble}</span>}
          </div>
        </div>
      </Card>

      <Card className="mt-4">
        <CardHead note={<span className="text-meta text-mute">This browser only.</span>}><span className="text-ui text-bone">Sign out</span></CardHead>
        <div className="px-4 py-4">
          <Button
            variant="quiet"
            disabled={logout.isPending}
            onClick={() =>
              logout.mutate(undefined as never, {
                onSettled: () => {
                  forgetToken();
                  router.replace("/login");
                },
              })
            }
          >
            Sign out
          </Button>
        </div>
      </Card>
    </div>
  );
}

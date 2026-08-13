import { notFound } from "next/navigation";
import { SessionView } from "@/components/SessionView";
import { byId, SESSIONS } from "@/lib/data";

export function generateStaticParams() {
  return SESSIONS.map((t) => ({ id: t.id }));
}

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = byId(id);
  if (!session) notFound();
  return <SessionView session={session} />;
}

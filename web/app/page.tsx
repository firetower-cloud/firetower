"use client";

import { Overview } from "@/components/Overview";

/**
 * Home.
 *
 * This was a dashboard, then it was the workbench with an empty middle, and
 * neither was a place to land: the first ended in navigating away from
 * everything, the second showed a workspace-shaped screen with no workspace in
 * it.
 *
 * It is the overview again, but of *workspaces* rather than sessions — which is
 * what a person has now that one place holds several agents.
 */
export default function Home() {
  return <Overview />;
}

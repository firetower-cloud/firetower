"use client";

import { Overview } from "@/components/Overview";

/**
 * Home.
 *
 * A page like Repos or Agents, in the rail they share — which is what it was
 * before the workbench landed, and what it stopped being when `/` started
 * rendering a workspace-shaped screen with no workspace in it.
 *
 * The overview it lost is here: every workspace, under the repository it is
 * working on, and the one control for ending all of them.
 */
export default function Home() {
  return <Overview />;
}

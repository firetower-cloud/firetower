"use client";

import { Workspace } from "@/components/workspace/Workspace";

/**
 * The workbench.
 *
 * This used to be a dashboard: a headline counting what was waiting on you,
 * cards for each of them, and a link into a session page. Every one of those
 * ended in navigating away, which meant the fleet and the work were never on
 * screen together — and the thing somebody actually does all day is glance at
 * one agent while another finishes.
 *
 * So the counting moved into the rail, the composer moved behind "new session",
 * and what is left in the middle is whatever you are reading.
 */
export default function Home() {
  return <Workspace />;
}

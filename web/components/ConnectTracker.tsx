"use client";

/**
 * Connecting a tracker that is not a git host.
 *
 * Linear has no device flow, so there is no short code to type and no way to
 * approve this from another screen — it connects with a key somebody makes in
 * Linear and brings back. The two things that makes worth getting right are
 * the trip to fetch it, which is a link rather than an instruction, and the
 * trip back, which is a paste.
 *
 * The key is checked before it is stored. One that does not work, kept anyway,
 * is an empty task list on another screen with nothing saying why.
 */

import { useState } from "react";
import { ArrowUpRight, ClipboardPaste } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Icon, Input } from "@/components/ui";
import { Modal, Foot, Go, Quiet, Failure } from "./Modal";
import {
  getListTrackersQueryKey,
  useSetTrackerKey,
} from "@/src/api/generated/trackers/trackers";
import type { TrackerStatus } from "@/src/api/generated/model";

export function ConnectTracker({
  tracker,
  onClose,
}: {
  tracker: TrackerStatus;
  onClose: () => void;
}) {
  const [key, setKey] = useState("");
  const [account, setAccount] = useState<string | null>(null);
  const [refused, setRefused] = useState<unknown>(null);
  const client = useQueryClient();

  const connect = useSetTrackerKey({
    mutation: {
      onSuccess: (result) => {
        setAccount(result.account);
        setRefused(null);
        client.invalidateQueries({ queryKey: getListTrackersQueryKey() });
      },
      onError: setRefused,
    },
  });

  const send = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setRefused(null);
    connect.mutate({ id: tracker.id, data: { key: trimmed } });
  };

  /**
   * The key that was just copied, without a trip through the field.
   *
   * Reading the clipboard needs a gesture and a permission, and Firefox has
   * no page-script `readText` at all — so this is an extra button rather than
   * something that happens on open, and typing still works when it fails.
   */
  const paste = async () => {
    try {
      const text = (await navigator.clipboard.readText()).trim();
      if (!text) return;
      setKey(text);
      send(text);
    } catch {
      // Denied, or unsupported. The field is right there.
    }
  };

  if (account) {
    return (
      <Modal title={`${tracker.label} connected`} onClose={onClose}>
        <p className="text-ui text-dim">
          Connected as <span className="text-bone">{account}</span>. Tasks reads{" "}
          {tracker.label} with this key, and only you can use it.
        </p>
        <Foot>
          <Go onClick={onClose}>Done</Go>
        </Foot>
      </Modal>
    );
  }

  return (
    <Modal title={`Connect ${tracker.label}`} onClose={onClose}>
      <ol className="space-y-3 text-ui text-dim">
        <li>
          <a
            href={tracker.keyUrl ?? undefined}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-bone underline decoration-line underline-offset-4 hover:decoration-dim"
          >
            Make a personal API key
            <Icon of={ArrowUpRight} size={12} />
          </a>{" "}
          in {tracker.label}.
        </li>
        <li>Copy it, and bring it back here.</li>
      </ol>

      <div className="mt-4 flex items-center gap-2">
        <Input
          value={key}
          onChange={setKey}
          mono
          placeholder="lin_api_…"
          className="flex-1"
          autoFocus
        />
        <Button icon={ClipboardPaste} onClick={paste} title="Use the key you copied">
          Paste
        </Button>
      </div>

      <p className="mt-2 text-meta text-mute">
        Kept in Firetower&rsquo;s vault, encrypted, against your account. Nothing is sent to a
        worker &mdash; tasks are read here.
      </p>

      {refused != null && <Failure error={refused} />}

      <Foot>
        <Go onClick={() => send(key)} disabled={!key.trim() || connect.isPending}>
          {connect.isPending ? "Checking…" : "Connect"}
        </Go>
        <Quiet onClick={onClose}>Cancel</Quiet>
      </Foot>
    </Modal>
  );
}

// frontend/src/components/transactions/NoteField.tsx
import { useState } from "react";
import { Input } from "../ui/Field";
import { SectionLabel } from "../ui/SectionLabel";
import { useSaveNote } from "./api";

/**
 * The user's memo on a transaction — distinct from the parsed description,
 * which stays untouchable provenance. Lives in the detail sheet; saves on
 * blur or Enter when the text changed, states the outcome quietly beside the
 * label, and keeps the typed text on failure so nothing is retyped.
 */
export function NoteField({ txnId, initial }: { txnId: number; initial: string }) {
  const [text, setText] = useState(initial);
  const [savedAs, setSavedAs] = useState(initial);
  const save = useSaveNote();

  const commit = () => {
    const next = text.trim();
    if (next === savedAs) return;
    save.mutate(
      { txnId, note: next },
      { onSuccess: () => setSavedAs(next) },
    );
  };

  const status = save.isPending
    ? { text: "Saving…", tone: "text-muted" }
    : save.isError
      ? { text: "Couldn't save — try again", tone: "text-bad" }
      : save.isSuccess && text.trim() === savedAs
        ? { text: "Saved", tone: "text-muted" }
        : null;

  return (
    <label className="block">
      <span className="flex items-baseline justify-between gap-2 mb-1">
        <SectionLabel as="span">Note</SectionLabel>
        {status && (
          <span role="status" className={`font-mono text-[10px] tracking-[0.04em] ${status.tone}`}>
            {status.text}
          </span>
        )}
      </span>
      <Input
        inset
        value={text}
        placeholder="Add a memo…"
        autoCapitalize="sentences"
        enterKeyHint="done"
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
    </label>
  );
}

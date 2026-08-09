/**
 * What is left of setup, once setup stopped being a corridor.
 *
 * # A list, not a walk, and a status, not a step
 *
 * Everything after account creation is skippable, so a user reaches the product
 * with any amount of it undone. This is where that shows up: the two or three
 * things still outstanding, and whether bank mail is actually arriving. Tapping
 * an item opens the same screen the walk would have — the caller decides what
 * that means on its surface.
 *
 * The mail line is the important half. It used to be a screen the user had to
 * sit on until their bank sent them an email; there is nothing to sit on now,
 * and it resolves itself whenever mail turns up, hours or days later, with no
 * screen to come back to.
 *
 * # Dismissed means dismissed
 *
 * The operator's standing instruction is that this app is already too verbose,
 * and a checklist that reappears is a nag. So the dismissal is written to the
 * same durable store the onboarding record uses, and this component renders
 * `null` for good afterwards — on that device, for that account, whatever is
 * still outstanding. The way back to a skipped step is Settings, which lists all
 * of them permanently and does not need this to be visible.
 *
 * The one thing that survives dismissal is nothing at all: no toast, no badge,
 * no "you still have 3 things to do" anywhere else. If that turns out to be the
 * wrong trade the answer is a Settings switch, not a list that comes back on its
 * own.
 */

import { useCallback, useState } from "react";

import type { SecretStore } from "@ledger/client/store/store";

import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Pressable } from "../../components/ui/Pressable";
import { SectionLabel } from "../../components/ui/SectionLabel";
import { ChevronRight } from "../../components/ui/PixelIcon";
import {
  MAIL_STATUS_COPY,
  mailStatus,
  remainingSetup,
  type OnboardingFacts,
  type SkippableStep,
} from "../../v2/onboarding";

/**
 * Where the dismissal lives.
 *
 * The {@link SecretStore} rather than component state or react-query, for the
 * reason `ONBOARDING_LOCAL_KEY` uses it: it is the one durable key-value store
 * the app already has, and a dismissal that did not survive a reload would be no
 * dismissal at all. Nothing secret goes in it — this is a boolean about a list.
 */
export const SETUP_DISMISSED_KEY = "setup_status_dismissed";

export function isSetupStatusDismissed(secrets: Pick<SecretStore, "get">): boolean {
  return secrets.get(SETUP_DISMISSED_KEY) === "1";
}

export function dismissSetupStatus(secrets: Pick<SecretStore, "set">): void {
  secrets.set(SETUP_DISMISSED_KEY, "1");
}

export interface SetupStatusProps {
  /** Read at boot, and the only source of what is outstanding. */
  facts: OnboardingFacts;
  /** Where the dismissal is kept. Injected by tests and by the shell. */
  secrets: Pick<SecretStore, "get" | "set">;
  /** Opens the screen that finishes one task. Absent renders plain rows. */
  onOpenTask?: (step: SkippableStep) => void;
  /** Opens held mail, where a provider's confirmation is read. */
  onOpenHeldMail?: () => void;
}

/**
 * The whole thing, or `null`.
 *
 * `null` in three cases, and they are deliberately different from each other:
 * the user dismissed it; there is nothing outstanding and mail is arriving; or
 * the account has not been set up at all, which is the boot gate's business
 * rather than this component's.
 */
export function SetupStatus({ facts, secrets, onOpenTask, onOpenHeldMail }: SetupStatusProps) {
  const [dismissed, setDismissed] = useState(() => isSetupStatusDismissed(secrets));
  const dismiss = useCallback(() => {
    dismissSetupStatus(secrets);
    setDismissed(true);
  }, [secrets]);

  const tasks = remainingSetup(facts);
  const mail = mailStatus(facts);
  if (dismissed) return null;
  if (tasks.length === 0 && mail.kind === "arrived") return null;

  const status = MAIL_STATUS_COPY[mail.kind];
  return (
    <section data-testid="setup-status" className="space-y-2">
      <SectionLabel as="h2" className="px-1">
        Finish setting up
      </SectionLabel>
      <Card className="!p-0 divide-y divide-border overflow-hidden">
        {/*
          The mail line first, because it is the one thing on here the user
          cannot do anything about — and saying so is the point. It is a status,
          not a row: there is nothing to tap.
        */}
        <div data-testid="setup-status-mail" className="px-4 py-3.5 space-y-1">
          <p className="text-sm font-medium">{status.title}</p>
          <p className="text-xs leading-relaxed text-muted">{status.body}</p>
          {/* "See what is waiting" and not "held mail": that is the name of the
              Settings row this sits above, and two controls with one name is
              how a person presses the wrong one. */}
          {mail.kind === "waiting" && onOpenHeldMail !== undefined && (
            <Button variant="ghost" onClick={onOpenHeldMail}>
              See what is waiting
            </Button>
          )}
        </div>

        {tasks.map((task) =>
          onOpenTask === undefined ? (
            <div key={task.id} data-testid={`setup-task-${task.id}`} className="px-4 py-3.5 space-y-1">
              <p className="text-sm font-medium">{task.title}</p>
              <p className="text-xs leading-relaxed text-muted">{task.detail}</p>
            </div>
          ) : (
            <Pressable
              key={task.id}
              data-testid={`setup-task-${task.id}`}
              onClick={() => onOpenTask(task.id)}
              className="w-full min-h-11 px-4 py-3.5 flex items-center justify-between gap-3 text-left hover:bg-surface-2/50"
            >
              <span className="space-y-1">
                <span className="block text-sm font-medium">{task.title}</span>
                <span className="block text-xs leading-relaxed text-muted">{task.detail}</span>
              </span>
              <ChevronRight size={16} aria-hidden className="shrink-0 text-muted" />
            </Pressable>
          ),
        )}
      </Card>
      {/*
        One press, and it is gone for good. Not "hide for now": a list that comes
        back is the nag this app has already been told off for.
      */}
      <div className="px-1">
        <Button variant="ghost" onClick={dismiss}>
          Hide this
        </Button>
      </div>
    </section>
  );
}

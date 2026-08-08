/**
 * The recovery step, at the level a user experiences it.
 *
 * Two things are load bearing here and neither is "the component renders":
 *
 *  1. **Nothing is published until the phrase has been confirmed**, and the
 *     confirmation is a check rather than a tick. A build that published on the
 *     tick would leave real accounts keyed by a phrase nobody wrote down.
 *  2. **The copy tells the truth.** The forbidden phrasings have their own test
 *     because they are what a well-meaning edit reaches for, and this text is a
 *     privacy claim to someone signing a consent document.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { RecoveryPhrase } from "./RecoveryPhrase";
import { MotionProvider } from "../../app/MotionProvider";
import { memoryKeyVault, type PublishedKeys } from "../../v2/keys";
import { RECOVERY_ENTRY_COPY, RECOVERY_PHRASE_COPY } from "../../v2/onboarding";
import { generateAccountKeys, wrapAccountKeys } from "@ledger/client/crypto/keys";
import { generatePhrase, validatePhrase } from "@ledger/client/crypto/phrase";
import { webPlatform } from "@ledger/client/platform.web";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const FAST = { t: 1, m: 64, p: 1 } as const;

function mount(node: React.ReactElement) {
  return render(<MotionProvider>{node}</MotionProvider>);
}

/** The words on the glass, read out of the numbered list. */
function shownWords(): string[] {
  const list = screen.getByTestId("recovery-phrase-words");
  return within(list)
    .getAllByRole("listitem")
    .map((li) => li.textContent!.replace(/^\d+/, "").trim());
}

describe("generating a phrase", () => {
  it("shows twelve real words and publishes nothing until they are confirmed", async () => {
    const user = userEvent.setup();
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const onSecured = vi.fn();

    mount(
      <RecoveryPhrase
        accountId={ACCOUNT}
        vault={memoryKeyVault()}
        io={{ sessionToken: "t", fetch: fetch as unknown as typeof globalThis.fetch }}
        published={null}
        onSecured={onSecured}
      />,
    );

    await screen.findByTestId("recovery-phrase-words");
    const words = shownWords();
    expect(words.length).toBe(12);
    expect(validatePhrase(words.join(" "), webPlatform).ok).toBe(true);
    expect(fetch).not.toHaveBeenCalled();

    // The tick alone is not the confirmation — it only reveals the check.
    await user.click(screen.getByRole("button", { name: RECOVERY_PHRASE_COPY.recorded }));
    expect(fetch).not.toHaveBeenCalled();
    await screen.findByTestId("onboarding-recovery-confirm");
    // And the words are no longer on the glass, which is what makes the check
    // one at all.
    expect(screen.queryByTestId("recovery-phrase-words")).toBeNull();

    const fields = screen.getAllByRole("textbox");
    expect(fields.length).toBe(3);
    for (const field of fields) {
      const position = Number(field.getAttribute("data-testid")!.replace("recovery-confirm-", ""));
      await user.type(field, words[position - 1]!);
    }
    await user.click(screen.getByRole("button", { name: RECOVERY_PHRASE_COPY.publish }));

    await waitFor(() => expect(onSecured).toHaveBeenCalled(), { timeout: 20_000 });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("PUT");
  }, 30_000);

  it("refuses a wrong word, and publishes nothing", async () => {
    const user = userEvent.setup();
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));

    mount(
      <RecoveryPhrase
        accountId={ACCOUNT}
        vault={memoryKeyVault()}
        io={{ sessionToken: "t", fetch: fetch as unknown as typeof globalThis.fetch }}
        published={null}
        onSecured={vi.fn()}
      />,
    );
    await screen.findByTestId("recovery-phrase-words");
    await user.click(screen.getByRole("button", { name: RECOVERY_PHRASE_COPY.recorded }));

    for (const field of screen.getAllByRole("textbox")) await user.type(field, "zoo");
    await user.click(screen.getByRole("button", { name: RECOVERY_PHRASE_COPY.publish }));

    expect(await screen.findByRole("alert")).toHaveTextContent(RECOVERY_PHRASE_COPY.confirmWrong);
    expect(fetch).not.toHaveBeenCalled();
  }, 30_000);

  it("can go back to the words, which is the last chance to read them", async () => {
    const user = userEvent.setup();
    mount(
      <RecoveryPhrase
        accountId={ACCOUNT}
        vault={memoryKeyVault()}
        io={{ sessionToken: "t", fetch: (async () => new Response(null, { status: 204 })) as typeof globalThis.fetch }}
        published={null}
        onSecured={vi.fn()}
      />,
    );
    await screen.findByTestId("recovery-phrase-words");
    const words = shownWords();
    await user.click(screen.getByRole("button", { name: RECOVERY_PHRASE_COPY.recorded }));
    await user.click(screen.getByRole("button", { name: RECOVERY_PHRASE_COPY.back }));
    // The SAME phrase, not a regenerated one: a new phrase here would mean the
    // words the user just wrote down were silently discarded.
    expect(shownWords()).toEqual(words);
  }, 30_000);

  // There is no skip. Not "the skip is discouraged" — there is no control that
  // leaves this step without keys, and a later edit that added one would fail
  // here.
  it("offers no way past the step", async () => {
    mount(
      <RecoveryPhrase
        accountId={ACCOUNT}
        vault={memoryKeyVault()}
        io={{ sessionToken: "t", fetch: (async () => new Response(null, { status: 204 })) as typeof globalThis.fetch }}
        published={null}
        onSecured={vi.fn()}
      />,
    );
    await screen.findByTestId("recovery-phrase-words");
    for (const button of screen.getAllByRole("button")) {
      expect(button.textContent!.toLowerCase()).not.toMatch(/skip|later|not now|remind me/);
    }
  });
});

describe("entering a phrase", () => {
  async function published(): Promise<{ published: PublishedKeys; phrase: string }> {
    const phrase = generatePhrase(webPlatform);
    const keys = generateAccountKeys(webPlatform);
    const ingestPub = Uint8Array.from(keys.ingestPub);
    const wrapped = await wrapAccountKeys(phrase, keys, webPlatform, FAST);
    return { published: { ingestPub, wrapped, keyVersion: 1 }, phrase };
  }

  it("recovers the account from the phrase alone", async () => {
    const user = userEvent.setup();
    const { published: pub, phrase } = await published();
    const onSecured = vi.fn();
    const vault = memoryKeyVault();

    mount(
      <RecoveryPhrase
        accountId={ACCOUNT}
        vault={vault}
        io={{ sessionToken: "t" }}
        published={pub}
        onSecured={onSecured}
      />,
    );
    await user.type(screen.getByTestId("recovery-entry-phrase"), phrase);
    await user.click(screen.getByRole("button", { name: RECOVERY_ENTRY_COPY.action }));

    await waitFor(() => expect(onSecured).toHaveBeenCalled(), { timeout: 20_000 });
    expect(await vault.read()).not.toBeNull();
  }, 30_000);

  // The reason the phrase is checksummed: the complaint names the word, in a
  // millisecond, instead of arriving after a several-second Argon2id run that
  // could only say "no".
  it("names a mistyped word without running the key derivation", async () => {
    const user = userEvent.setup();
    const { published: pub, phrase } = await published();
    const typo = phrase.replace(/^(\w+)/, "notaword");

    mount(
      <RecoveryPhrase
        accountId={ACCOUNT}
        vault={memoryKeyVault()}
        io={{ sessionToken: "t" }}
        published={pub}
        onSecured={vi.fn()}
      />,
    );
    await user.type(screen.getByTestId("recovery-entry-phrase"), typo);
    const started = Date.now();
    await user.click(screen.getByRole("button", { name: RECOVERY_ENTRY_COPY.action }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("notaword");
    expect(Date.now() - started).toBeLessThan(1000);
  }, 30_000);

  it("stores nothing when the phrase is well-formed but wrong", async () => {
    const user = userEvent.setup();
    const { published: pub } = await published();
    const vault = memoryKeyVault();

    mount(
      <RecoveryPhrase
        accountId={ACCOUNT}
        vault={vault}
        io={{ sessionToken: "t" }}
        published={pub}
        onSecured={vi.fn()}
      />,
    );
    await user.type(screen.getByTestId("recovery-entry-phrase"), generatePhrase(webPlatform));
    await user.click(screen.getByRole("button", { name: RECOVERY_ENTRY_COPY.action }));
    expect((await screen.findByRole("alert")).textContent).toBe(RECOVERY_ENTRY_COPY.failed);
    expect(await vault.read()).toBeNull();
  }, 30_000);
});

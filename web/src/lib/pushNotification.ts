/**
 * What a push notification says, decided on the CLIENT.
 *
 * # The service worker never renders a server-supplied string
 *
 * The server does send a payload (`{"title":"New activity"}`, pinned by
 * `internal/v2/pushv2/webpush_test.go`), and this module deliberately ignores
 * it. `notificationFor` takes the push data and returns a constant.
 *
 * That is not belt-and-braces about a hostile server — the payload is encrypted
 * to this browser's own subscription keys, so only our server can compose one.
 * It is about the failure mode that actually happens: somebody adds the
 * merchant name to the server payload "just for usefulness", and every deployed
 * client starts rendering spending detail on a lock screen. With the text
 * decided here, that edit changes nothing until this file changes too, and this
 * file is where the reason is written down.
 *
 * # Why the notification says so little
 *
 * A notification is drawn on a LOCK SCREEN — the one surface visible without
 * the device being unlocked — and it travels through Apple's, Google's or
 * Mozilla's push service. Nothing on those hops is covered by the encryption
 * the rest of this design is built on. So the push says that something arrived;
 * the app decrypts and shows what, when it is opened.
 *
 * Even a COUNT is content: "3 new transactions" on a Tuesday afternoon is a
 * spending-frequency signal.
 *
 * # It is framework-free on purpose
 *
 * `src/sw.ts` is compiled as a service worker (no DOM, no React) and imports
 * this; the test imports it as ordinary code. Nothing here may touch `window`,
 * `document` or `self`.
 */

/** The whole text of a notification. */
export const PUSH_TITLE = "New activity";

/**
 * The notification tag.
 *
 * Constant, so a burst of transactions collapses into ONE notification instead
 * of a stack that counts them — a stack of five is the count this design
 * refuses to send, reassembled by the operating system.
 */
export const PUSH_TAG = "ledger-activity";

/** Where a tapped notification takes you. Relative, resolved against scope. */
const PUSH_TARGET_PATH = "/";

export interface PushNotification {
  title: string;
  options: {
    body: string;
    tag: string;
    /** Replace the previous notification silently rather than re-alerting. */
    renotify: false;
    data: { path: string };
  };
}

/**
 * The notification to show for a push.
 *
 * The parameter is accepted and ignored. It is in the signature so that a
 * reader of `sw.ts` can see that the payload reached this decision and was not
 * used, rather than wondering whether the service worker forgot to read it.
 */
export function notificationFor(_data?: unknown): PushNotification {
  return {
    title: PUSH_TITLE,
    options: {
      // Empty, not absent. A body composed from a transaction is the one thing
      // this whole path exists to not do.
      body: "",
      tag: PUSH_TAG,
      renotify: false,
      data: { path: PUSH_TARGET_PATH },
    },
  };
}

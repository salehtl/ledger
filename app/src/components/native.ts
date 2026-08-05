/**
 * The clipboard, behind the same seam every other native module in this app
 * sits behind (`auth/native.ts`, `account/native.ts`, `screens/import/native.ts`).
 *
 * This file is the ONLY one that imports `expo-clipboard`, so a screen can be
 * mounted in a test without the native module, and the copy affordance can be
 * *observed* in that test rather than mocked away. On a 26-character base32
 * address, copying is not a convenience: the brief's words are that typing it
 * on a phone keyboard "is how onboarding dies".
 */

import { Linking } from "react-native";
import * as Clipboard from "expo-clipboard";

export type CopyToClipboard = (text: string) => Promise<void>;

export const copyToClipboard: CopyToClipboard = async (text) => {
  await Clipboard.setStringAsync(text);
};

/**
 * Opening a URL, behind the same seam.
 *
 * Only ever called with a URL whose scheme, host and path prefix are literals
 * in `lib/verificationCode.ts`'s pattern, so what this opens is
 * `mail-settings.google.com` and cannot be anything else - the attacker
 * controls only the opaque tail of a Google URL. That constraint lives at the
 * pattern rather than here on purpose: a check in this function would be a
 * second place for the rule to be written down and later disagree.
 */
export type OpenLink = (url: string) => Promise<void>;

export const openLink: OpenLink = async (url) => {
  await Linking.openURL(url);
};

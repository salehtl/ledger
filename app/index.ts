/**
 * The entry point.
 *
 * The import order below is the only thing in this file, and it is load-bearing:
 * `./src/platform` installs the React Native implementation into
 * `client/src`'s seam, and until it has run `platform()` throws. Under Metro,
 * `client/src/platform.ts`'s Bun auto-install cannot fire — `node:zlib` and
 * `node:crypto` are stubbed to empty modules — so the registry really is empty
 * at start-up rather than holding a fallback nobody meant to ship.
 *
 * ES module evaluation is in source order, so putting this first is sufficient
 * and there is no need for a side-channel or a lazy initialiser.
 */

import "./src/platform/index.ts";

import { registerRootComponent } from "expo";

import { Root } from "./src/app/Root.tsx";

registerRootComponent(Root);

/**
 * Component-test setup.
 *
 * Two things, both about not letting a test pass for the wrong reason.
 *
 * 1. **The platform seam is installed.** Any component that reaches
 *    `client/src` calls `platform()`, which throws while the registry is
 *    empty. `app/src/platform/index.ts` cannot be used here — it imports
 *    `expo-crypto`, a native module — so the same `createPlatform` the device
 *    uses is built over Node's crypto. The implementation under test is
 *    therefore the real one; only the RNG differs.
 *
 * 2. **Reanimated's mock.** `react-native-reanimated` needs its jest setup to
 *    render at all under jsdom. Without it, `Animated.View` throws on mount and
 *    every component test fails for a reason that has nothing to do with the
 *    component.
 */

require("react-native-reanimated").setUpTests?.();

const { setPlatform } = require("../client/src/platform.ts");
const { createPlatform } = require("./src/platform/platform.ts");
const nodeCrypto = require("node:crypto");

setPlatform(
  createPlatform({
    randomUUID: () => nodeCrypto.randomUUID(),
    randomBytes: (n) => new Uint8Array(nodeCrypto.randomBytes(n)),
  }),
);

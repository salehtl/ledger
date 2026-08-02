/**
 * The **second** test runner, and it is second on purpose.
 *
 * `bun test src` is the primary one: it is fast, it is what every pure module
 * under `src/platform/`, `src/db/` and `src/lib/` is written against, and it
 * runs the seam's whole contract in ~2 s. It cannot render a component:
 * `react-native`'s entry point is Flow-typed (`import typeof * as … from
 * './index.js.flow'`) and Bun's transpiler has no Flow support, so
 * `import "react-native"` fails to parse before any test body runs.
 *
 * So components go through `jest-expo`, which is the Expo-supported preset and
 * carries the Babel transform that strips Flow, the React Native mocks and the
 * `haste` resolution RN's own modules assume.
 *
 * The split is by capability, not by taste, and the file patterns enforce it:
 * jest takes `*.rn-test.tsx`, bun takes `*.test.ts(x)`. A file that needs
 * `react-native` and is named `.test.ts` fails loudly under bun rather than
 * being silently skipped by both.
 *
 * `app/test/device/` is run by NEITHER. Those suites are driven from the bench
 * screen on a real device and their results are recorded in task reports —
 * there is no CI service and no simulator on this box.
 */

/** @type {import('jest').Config} */
module.exports = {
  preset: "jest-expo",
  testMatch: ["<rootDir>/src/**/*.rn-test.@(ts|tsx)"],
  testPathIgnorePatterns: ["<rootDir>/node_modules/", "<rootDir>/test/device/", "<rootDir>/.expo/"],
  setupFilesAfterEnv: ["<rootDir>/jest.setup.js"],
  moduleNameMapper: {
    "^@ledger/client/(.*)$": "<rootDir>/../client/src/$1",
    // `client/src` lives outside `<rootDir>`, so Babel's injected helper
    // requires resolve from `client/` — which has no `@babel/runtime`. Pointing
    // them at `app/`'s copy is the jest equivalent of `metro.config.js`'s
    // `nodeModulesPaths`, and for the same reason: one copy of everything.
    "^@babel/runtime/(.*)$": "<rootDir>/node_modules/@babel/runtime/$1",
  },
  // `@noble/*`, `fflate` and `ulid` ship ESM only. They are the seam's real
  // dependencies, so they must be transformed rather than mocked — a component
  // test that stubs the hash is a component test that proves nothing about the
  // hash.
  transformIgnorePatterns: [
    "node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg|react-native-reanimated|react-native-worklets|@noble/.*|fflate|ulid))",
  ],
};

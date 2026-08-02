/**
 * The navigator.
 *
 * A **native** stack (`@react-navigation/native-stack`), not the JS stack:
 * screen transitions run on the platform's own navigation controller, which is
 * the difference between a push that keeps 60 fps while the JS thread is busy
 * folding a log and one that does not. Task 8's sync work blocks the JS thread
 * in multi-second slabs (Phase 0 measured ~3.8 s), so this is not a preference.
 *
 * `RootStackParamList` is the single source of route names and params. Every
 * later task adds its screen here and to that type in the same commit — an
 * untyped `navigate("Whatever")` is a runtime crash React Navigation cannot
 * catch for you.
 */

import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { useMemo } from "react";

import { deviceSignInDeps } from "../auth/native.ts";
import { SignInScreen } from "../screens/onboarding/SignInScreen.tsx";
import { Shell } from "../screens/Shell.tsx";
import { useTheme } from "./Theme.tsx";

export type RootStackParamList = {
  SignIn: undefined;
  Shell: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export function Navigation() {
  const t = useTheme();
  /**
   * Built once. `deviceSignInDeps` allocates objects and touches no native
   * module until something is pressed, but rebuilding it per render would hand
   * the screen a new `apple` object every time and re-run its availability
   * effect.
   *
   * **`backend` is null here** — see `auth/native.ts`. Task 8 constructs the
   * `Client` (it needs the one database handle and a server base URL that this
   * repo deliberately does not record) and passes it in; until then the screen
   * says so on the glass rather than failing at tap time.
   */
  const signInDeps = useMemo(() => deviceSignInDeps(), []);

  return (
    <Stack.Navigator
      initialRouteName="SignIn"
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: t.colors.bg },
      }}
    >
      {/*
        A render callback rather than `component`: the screen takes its
        dependencies as props so that nothing in `src/auth/native.ts` — the one
        module that imports `expo-apple-authentication`, `expo-auth-session`
        and `expo-secure-store` — has to be loaded by a test to render it.
      */}
      <Stack.Screen name="SignIn">
        {({ navigation }) => (
          <SignInScreen
            deps={signInDeps}
            onSignedIn={() => navigation.replace("Shell")}
            onSkip={() => navigation.navigate("Shell")}
          />
        )}
      </Stack.Screen>
      <Stack.Screen name="Shell" component={Shell} />
    </Stack.Navigator>
  );
}

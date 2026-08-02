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

import { Shell } from "../screens/Shell.tsx";
import { useTheme } from "./Theme.tsx";

export type RootStackParamList = {
  Shell: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export function Navigation() {
  const t = useTheme();
  return (
    <Stack.Navigator
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: t.colors.bg },
      }}
    >
      <Stack.Screen name="Shell" component={Shell} />
    </Stack.Navigator>
  );
}

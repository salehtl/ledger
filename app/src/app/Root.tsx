/**
 * The root component: every provider the tree needs, in the order it needs
 * them, and nothing else.
 *
 * Order matters twice here:
 *
 *  - `SafeAreaProvider` is outermost because both the navigator and every
 *    screen read insets from it, and a consumer above the provider silently
 *    reads zeros — which on a notched device is a title under the status bar
 *    and a button under the home indicator.
 *  - `ThemeProvider` is above `NavigationContainer` because the container is
 *    themed from the same palette. Two sources of "what colour is the
 *    background" is how a screen ends up with a one-frame flash of the wrong
 *    one during a push.
 *  - `ErrorBoundary` is below `ThemeProvider` (so its fallback is themed) and
 *    above everything else (so it catches a throw from any screen). See
 *    `components/ErrorBoundary.tsx` for why the app needs one at all.
 */

import { DarkTheme, DefaultTheme, NavigationContainer, type Theme as NavTheme } from "@react-navigation/native";
import { StatusBar } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ErrorBoundary } from "../components/ErrorBoundary.tsx";
import { Navigation } from "./Navigation.tsx";
import { RuntimeProvider } from "./RuntimeProvider.tsx";
import { ThemeProvider, useTheme } from "./Theme.tsx";

function ThemedContainer() {
  const t = useTheme();
  const base = t.scheme === "dark" ? DarkTheme : DefaultTheme;
  const navTheme: NavTheme = {
    ...base,
    dark: t.scheme === "dark",
    colors: {
      ...base.colors,
      primary: t.colors.accent,
      background: t.colors.bg,
      card: t.colors.surface,
      text: t.colors.text,
      border: t.colors.hairline,
      notification: t.colors.danger,
    },
  };
  return (
    <>
      <StatusBar barStyle={t.scheme === "dark" ? "light-content" : "dark-content"} backgroundColor={t.colors.bg} />
      <NavigationContainer theme={navTheme}>
        <RuntimeProvider>
          <Navigation />
        </RuntimeProvider>
      </NavigationContainer>
    </>
  );
}

export function Root() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        {/*
          INSIDE `ThemeProvider` so the fallback is themed, and OUTSIDE
          everything else so it catches a throw from any screen.

          It is here because `BudgetScreen` reads its source synchronously
          during render and the money guard behind that read fails closed by
          throwing. Failing closed is correct and must stay; landing on a blank
          white screen with no message and no way back is not, and that is what
          an uncaught render error does — React unmounts the whole tree.
        */}
        <ErrorBoundary>
          <ThemedContainer />
        </ErrorBoundary>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

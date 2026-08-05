/**
 * The last thing between a throw during render and a blank white screen.
 *
 * # Why this exists at all
 *
 * `grep -rn "componentDidCatch" app/src` returned nothing, while
 * `BudgetScreen.tsx` calls `source.read(nowMs)` synchronously DURING RENDER and
 * the money guard behind it (`budget/source.ts`'s `exact()`) fails CLOSED by
 * throwing — deliberately, and that guard must keep its teeth. Failing closed is
 * right; failing closed into an unrecoverable white screen is not. React
 * unmounts the entire tree on an uncaught render error, so without a boundary
 * the app's answer to "one aggregate did not come back as an integer" was a
 * blank app with no message, no back, and nothing to press.
 *
 * `TransactionsScreen` has a local `try/catch` around exactly this class of
 * failure and renders the reason on the glass. This is the same idea for
 * everything that does not.
 *
 * # It is a class, and it has to be
 *
 * `getDerivedStateFromError` / `componentDidCatch` have no hook equivalent.
 * That is a React constraint, not a style choice.
 *
 * # What it renders
 *
 * The error text, verbatim, and a control that clears the boundary. The text is
 * shown rather than swallowed because this app has one user in the beta and the
 * message is the whole diagnostic; `budget/source.ts`'s throws say which column
 * failed to decode. "Try again" re-mounts the subtree, which is the right offer
 * when the cause is a projection mid-rebuild — it is the same read, and it will
 * succeed once the sync finishes.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";

import { TOUCH_TARGET_MIN, useTheme } from "../app/Theme.tsx";

interface Props {
  children: ReactNode;
  /** Test seam: production has no reporter and nothing leaves the device. */
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    return <ErrorScreen error={error} onRetry={() => this.setState({ error: null })} />;
  }
}

function ErrorScreen({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const t = useTheme();
  return (
    <View testID="app-error-boundary" style={{ flex: 1, backgroundColor: t.colors.bg, padding: t.space.lg, justifyContent: "center", gap: t.space.md }}>
      <Text accessibilityRole="header" style={[t.type.title, { color: t.colors.text }]}>
        Something went wrong
      </Text>
      <Text style={[t.type.body, { color: t.colors.text }]}>
        Nothing on your phone was changed and nothing was lost — ledger stopped rather than show you a number it
        could not stand behind.
      </Text>
      <ScrollView style={{ maxHeight: 200 }}>
        <Text testID="app-error-detail" accessibilityRole="alert" style={[t.type.label, { color: t.colors.danger }]}>
          {error.message}
        </Text>
      </ScrollView>
      <Pressable
        testID="app-error-retry"
        accessibilityRole="button"
        onPress={onRetry}
        style={{ minHeight: TOUCH_TARGET_MIN, justifyContent: "center" }}
      >
        <Text style={[t.type.body, { color: t.colors.accent }]}>Try again</Text>
      </Pressable>
    </View>
  );
}

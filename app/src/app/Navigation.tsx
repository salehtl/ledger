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
import { ActivityIndicator, Text, View } from "react-native";

import { deviceSignInDeps } from "../auth/native.ts";
import { hasSession } from "../auth/session.ts";
import { loadLocalRecord, resumeFacts, saveLocalRecord } from "../lib/onboarding.ts";
import { OnboardingShell } from "../screens/onboarding/OnboardingShell.tsx";
import { SignInScreen } from "../screens/onboarding/SignInScreen.tsx";
import { Shell } from "../screens/Shell.tsx";
import { TransactionsScreen } from "../screens/transactions/TransactionsScreen.tsx";
import { TransactionDetailScreen } from "../screens/transactions/TransactionDetailScreen.tsx";
import { ReviewScreen } from "../screens/review/ReviewScreen.tsx";
import { QuarantineScreen } from "../screens/quarantine/QuarantineScreen.tsx";
import { CurrenciesScreen } from "../screens/currencies/CurrenciesScreen.tsx";
import { ImportScreen } from "../screens/import/ImportScreen.tsx";
import { pickCSVDocument } from "../screens/import/native.ts";
import { ReprocessScreen } from "../screens/settings/ReprocessScreen.tsx";
import { BudgetScreen } from "../screens/budget/BudgetScreen.tsx";
import { BankScreen } from "../screens/onboarding/BankScreen.tsx";
import { ExportScreen } from "../screens/settings/ExportScreen.tsx";
import { DeleteAccountScreen } from "../screens/settings/DeleteAccountScreen.tsx";
import { SecurityScreen } from "../screens/settings/SecurityScreen.tsx";
import { sqlExportSource, exportAndShare } from "../account/export.ts";
import { nativeExportIO } from "../account/native.ts";
import { deleteAccount } from "../account/deletion.ts";
import { useTheme } from "./Theme.tsx";
import { useAccountWipe, useBootstrap, useRuntime } from "./RuntimeProvider.tsx";

export type RootStackParamList = {
  SignIn: undefined;
  /**
   * `userId` is the account the exchange returned, or **null** when a session
   * was already on this device and no exchange happened this launch. The
   * distinction is a real onboarding state (`signed_in` versus `invited`), not
   * bookkeeping: a stored session proves a token, and only a server answer
   * proves the account still exists.
   *
   * A user *id* is not a credential — Task 13's rule is that a live ID token
   * never travels through navigation params, and this is not one.
   */
  Onboarding: { userId: string | null };
  Shell: undefined;
  Transactions: undefined;
  TransactionDetail: { id: string };
  Review: undefined;
  Quarantine: undefined;
  Currencies: undefined;
  Import: undefined;
  Reprocess: undefined;
  Budget: undefined;
  Export: undefined;
  DeleteAccount: undefined;
  Security: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export function Navigation() {
  const t = useTheme();
  const runtime = useRuntime();
  const bootstrap = useBootstrap();
  const wipeAccount = useAccountWipe();
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
  const signInDeps = useMemo(
    () => deviceSignInDeps({ backend: runtime.client, secrets: runtime.secrets }),
    [runtime],
  );

  if (bootstrap.step === "opening") {
    return <View testID="bootstrap-opening" style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: t.colors.bg }}><ActivityIndicator color={t.colors.accent} /></View>;
  }
  if (bootstrap.step === "fatal" || bootstrap.step === "halted") {
    const detail = bootstrap.step === "fatal" ? bootstrap.error.message : bootstrap.reason;
    return <View testID="bootstrap-fatal" style={{ flex: 1, padding: t.space.lg, justifyContent: "center", backgroundColor: t.colors.bg }}><Text accessibilityRole="alert" style={[t.type.body, { color: t.colors.danger }]}>Ledger could not safely open this account. {detail}</Text></View>;
  }

  return (
    <Stack.Navigator
      initialRouteName={bootstrap.step === "signed_out" ? "SignIn" : bootstrap.step === "ready" ? "Transactions" : "Onboarding"}
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
            onSignedIn={(userId) => navigation.replace("Onboarding", { userId })}
            onSkip={() => navigation.navigate("Shell")}
          />
        )}
      </Stack.Screen>
      {/*
        Onboarding's step is DERIVED from facts on every mount, so this route
        takes no state of its own beyond the account the exchange returned.

        Three of those facts need a `Client` that does not exist yet (Task 13's
        handoff): the inbound address, the first confirmed bank email and the
        home currency, which is read from the folded log and from nowhere else.
        They are passed as `null` and the shell renders the step that names what
        is missing — rather than a fabricated default, which would walk the
        machine past steps that never happened.
      */}
      <Stack.Screen
        name="Onboarding"
        initialParams={{ userId: bootstrap.step === "onboarding" || bootstrap.step === "ready" ? bootstrap.userId : null }}
      >
        {({ navigation, route }) => (
          <OnboardingShell
            initialFacts={resumeFacts({
              hasSession: hasSession(signInDeps.secrets),
              accountId: route.params.userId,
              inboundAddress: bootstrap.step === "onboarding" ? bootstrap.facts?.inboundAddress ?? null : null,
              firstMailConfirmedAt: bootstrap.step === "onboarding" ? bootstrap.facts?.firstMailConfirmedAt ?? null : null,
              homeCurrency: bootstrap.step === "onboarding" ? bootstrap.facts?.homeCurrency ?? null : null,
              local: loadLocalRecord(signInDeps.secrets),
            })}
            onFactsChange={(f) => saveLocalRecord(signInDeps.secrets, f)}
            commitOps={(ops) => runtime.commitOnboardingOps(ops)}
            screens={{ bank: ({ advance }) => <BankScreen waitlist={runtime.waitlist} onSelect={(bank) => advance({ type: "bank_picked", bank })} onInviteDonation={() => navigation.navigate("Review")} /> }}
            onDone={() => navigation.replace("Transactions")}
            onSignedOut={() => navigation.replace("SignIn")}
          />
        )}
      </Stack.Screen>
      <Stack.Screen name="Transactions">
        {({ navigation }) => (
          <TransactionsScreen
            source={runtime.txns}
            nowIso={new Date().toISOString()}
            onOpen={(id) => navigation.navigate("TransactionDetail", { id })}
            onReview={() => navigation.navigate("Review")}
            onQuarantine={() => navigation.navigate("Quarantine")}
            onCurrencies={() => navigation.navigate("Currencies")}
            onImport={() => navigation.navigate("Import")}
            onReprocess={() => navigation.navigate("Reprocess")}
            onBudget={() => navigation.navigate("Budget")}
            onExport={() => navigation.navigate("Export")}
            onDeleteAccount={() => navigation.navigate("DeleteAccount")}
            onSecurity={() => navigation.navigate("Security")}
          />
        )}
      </Stack.Screen>
      <Stack.Screen name="Quarantine">
        {() => <QuarantineScreen source={runtime.quarantine} />}
      </Stack.Screen>
      <Stack.Screen name="Currencies">
        {({ navigation }) => <CurrenciesScreen source={runtime.currencies} onClose={() => navigation.goBack()} />}
      </Stack.Screen>
      <Stack.Screen name="Import">
        {({ navigation }) => <ImportScreen pick={pickCSVDocument} io={runtime.importIO} onDone={() => navigation.goBack()} />}
      </Stack.Screen>
      <Stack.Screen name="Reprocess">
        {({ navigation }) => <ReprocessScreen start={runtime.reprocess.start} onClose={() => navigation.goBack()} />}
      </Stack.Screen>
      <Stack.Screen name="Budget">
        {({ navigation }) => <BudgetScreen source={runtime.budget} nowMs={Date.now()} onCurrencies={() => navigation.navigate("Currencies")} onImport={() => navigation.navigate("Import")} onClose={() => navigation.goBack()} />}
      </Stack.Screen>
      <Stack.Screen name="Export">
        {() => <ExportScreen run={async (format) => exportAndShare(sqlExportSource(runtime.db, new Date().toISOString()), format, nativeExportIO())} />}
      </Stack.Screen>
      <Stack.Screen name="Security">
        {() => <SecurityScreen identity={runtime.deviceIdentity()} />}
      </Stack.Screen>
      {/*
        Two endings erase this device - `204` and `410 account_deleted` - and
        BOTH must leave the signed-in graph. `deleteAccount` returns on those
        two and throws on everything else, so the reset below covers the 410
        that arrives on the user's *other* device: it used to wipe, throw, skip
        this reset, and leave the delete screen saying the data was still here.
      */}
      <Stack.Screen name="DeleteAccount">
        {({ navigation }) => <DeleteAccountScreen onExport={() => navigation.navigate("Export")} remove={async () => { const result = await deleteAccount({ server: runtime.server, userId: () => runtime.store.load().userId, secrets: runtime.secrets, authenticator: signInDeps.apple, wipe: wipeAccount }); navigation.reset({ index: 0, routes: [{ name: "SignIn" }] }); return result; }} />}
      </Stack.Screen>
      <Stack.Screen name="Review">
        {({ navigation }) => <ReviewScreen deps={{ source: runtime.review, writer: runtime.outbox, raw: runtime.rawMessages, dictionary: runtime.dictionary, samples: runtime.samples, newID: runtime.newId }} onClose={() => navigation.goBack()} />}
      </Stack.Screen>
      <Stack.Screen name="TransactionDetail">
        {({ navigation, route }) => (
          <TransactionDetailScreen
            source={runtime.txns}
            id={route.params.id}
            onReplaced={(id) => navigation.replace("TransactionDetail", { id })}
            onClose={() => navigation.goBack()}
          />
        )}
      </Stack.Screen>
      <Stack.Screen name="Shell" component={Shell} />
    </Stack.Navigator>
  );
}

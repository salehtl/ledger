/**
 * The review deck's own small pieces.
 *
 * They are here rather than in `app/src/components/` on purpose: none of them
 * has a second caller yet, and a "shared" component with one user is a
 * premature abstraction that the next screen then has to fight. When the
 * transactions screen wants the category grid, it moves — with its catalogue
 * row, in that commit.
 */

import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import { INPUT_FONT_MIN, TOUCH_TARGET_MIN, useTheme } from "../../app/Theme.tsx";
import { categoryIsUsable, REVIEW_REASON_COPY, type ReviewReason } from "../../lib/review.ts";

/**
 * Why this row is in the queue, in the user's words.
 *
 * The three reasons a user meets are three different situations and this is
 * where they stop looking identical. The detail is always visible; the
 * technical account is behind a press, because a screen that opened with DKIM
 * header coverage would be a screen nobody reads.
 */
export function ReasonBanner({ reason }: { reason: ReviewReason }) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const copy = REVIEW_REASON_COPY[reason];
  // The unreadable case is the one where something is actually missing; the
  // others are cautions. Colour follows that rather than shouting at the
  // common case.
  const tint = reason === "unreadable" ? t.colors.danger : t.colors.warning;

  return (
    <View style={{ gap: t.space.xs }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: t.space.sm }}>
        <View style={{ width: t.space.sm, height: t.space.sm, borderRadius: t.radius.pill, backgroundColor: tint }} />
        <Text style={[t.type.label, { color: tint }]}>{copy.title}</Text>
      </View>
      <Text style={[t.type.body, { color: t.colors.textMuted }]}>{copy.detail}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={open ? "Hide the details" : "Why am I seeing this?"}
        onPress={() => setOpen((v) => !v)}
        hitSlop={t.space.md}
        style={{ minHeight: TOUCH_TARGET_MIN, justifyContent: "center" }}
      >
        <Text style={[t.type.label, { color: t.colors.accent }]}>{open ? "Hide the details" : "Why am I seeing this?"}</Text>
      </Pressable>
      {open ? <Text style={[t.type.label, { color: t.colors.textMuted }]}>{copy.more}</Text> : null}
    </View>
  );
}

export interface ButtonProps {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: "primary" | "secondary" | "danger";
  /** Rendered under the label — used for "why is this disabled". */
  note?: string;
}

export function Button({ label, onPress, disabled = false, tone = "secondary", note }: ButtonProps) {
  const t = useTheme();
  const bg = tone === "primary" ? t.colors.accent : "transparent";
  const fg = tone === "primary" ? t.colors.bg : tone === "danger" ? t.colors.danger : t.colors.text;
  return (
    <View style={{ gap: t.space.xs }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled }}
        accessibilityLabel={label}
        disabled={disabled}
        onPress={onPress}
        hitSlop={t.space.sm}
        style={{
          minHeight: TOUCH_TARGET_MIN,
          paddingHorizontal: t.space.lg,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: t.radius.md,
          backgroundColor: bg,
          borderWidth: tone === "primary" ? 0 : 1,
          borderColor: t.colors.hairline,
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <Text style={[t.type.heading, { color: fg }]}>{label}</Text>
      </Pressable>
      {note === undefined ? null : <Text style={[t.type.label, { color: t.colors.textMuted }]}>{note}</Text>}
    </View>
  );
}

export interface CategoryGridProps {
  categories: readonly string[];
  selected: string | null;
  onSelect: (category: string | null) => void;
}

/**
 * The category grid.
 *
 * Ordered by what this user actually spends on (`topCategories`), because on a
 * screen touched dozens of times a day the four tiles that cover most spending
 * belong under the thumb. "Something else" is an inline field rather than a
 * sheet — a sheet over a card the user is mid-way through answering hides the
 * amount they are categorising.
 */
export function CategoryGrid({ categories, selected, onSelect }: CategoryGridProps) {
  const t = useTheme();
  const [custom, setCustom] = useState<string | null>(null);
  const draft = custom ?? "";
  const customOk = categoryIsUsable(draft);

  return (
    <View style={{ gap: t.space.sm }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: t.space.sm }}>
        {categories.map((c) => {
          const on = selected === c;
          return (
            <Pressable
              key={c}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              accessibilityLabel={c}
              onPress={() => onSelect(on ? null : c)}
              style={{
                minHeight: TOUCH_TARGET_MIN,
                justifyContent: "center",
                paddingHorizontal: t.space.lg,
                borderRadius: t.radius.pill,
                borderWidth: 1,
                borderColor: on ? t.colors.accent : t.colors.hairline,
                backgroundColor: on ? t.colors.accent : "transparent",
              }}
            >
              <Text style={[t.type.body, { color: on ? t.colors.bg : t.colors.text }]}>{c}</Text>
            </Pressable>
          );
        })}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Something else"
          onPress={() => setCustom((v) => (v === null ? "" : null))}
          style={{
            minHeight: TOUCH_TARGET_MIN,
            justifyContent: "center",
            paddingHorizontal: t.space.lg,
            borderRadius: t.radius.pill,
            borderWidth: 1,
            borderColor: t.colors.hairline,
          }}
        >
          <Text style={[t.type.body, { color: t.colors.textMuted }]}>Something else</Text>
        </Pressable>
      </View>

      {custom === null ? null : (
        <View style={{ flexDirection: "row", gap: t.space.sm, alignItems: "center" }}>
          <TextInput
            accessibilityLabel="New category"
            value={draft}
            onChangeText={(v) => {
              setCustom(v);
              // Applied only when it is usable; a half-typed word must not
              // become the selection and then the rule.
              onSelect(categoryIsUsable(v) ? v.trim() : null);
            }}
            autoCapitalize="words"
            style={{
              flex: 1,
              minHeight: TOUCH_TARGET_MIN,
              fontSize: INPUT_FONT_MIN,
              color: t.colors.text,
              borderWidth: 1,
              borderColor: t.colors.hairline,
              borderRadius: t.radius.md,
              paddingHorizontal: t.space.md,
            }}
          />
          <Text style={[t.type.label, { color: customOk ? t.colors.credit : t.colors.textMuted }]}>{customOk ? "Ready" : "2–32 characters"}</Text>
        </View>
      )}
    </View>
  );
}

/** A labelled value, the way every card shows a field. */
export function Field({ label, value, tone }: { label: string; value: string; tone?: "muted" | "strong" }) {
  const t = useTheme();
  return (
    <View style={{ gap: 2 }}>
      <Text style={[t.type.label, { color: t.colors.textMuted }]}>{label}</Text>
      <Text style={[tone === "strong" ? t.type.title : t.type.body, { color: tone === "muted" ? t.colors.textMuted : t.colors.text }]}>{value}</Text>
    </View>
  );
}

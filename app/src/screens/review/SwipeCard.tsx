/**
 * The deck's one card, and the gesture that answers it.
 *
 * # Why a gesture at all
 *
 * v1's UX notes record that the operator dislikes bottom-sheet-everything and
 * prefers swipe plus inline filters. This screen is where that preference
 * stops being taste: with every DIB message landing in `needs_review`, confirming
 * is something a person does several times a day, and the difference between a
 * thumb flick and a two-tap dialog is the difference between a queue that gets
 * emptied and one that grows.
 *
 * Every button the gesture replaces is **also** on the card. A gesture is an
 * accelerator, never the only way to do something: it is undiscoverable, it is
 * hard for a user with a motor impairment, and `accessibilityRole="button"` on
 * a `PanResponder` is a lie a screen reader cannot use.
 *
 * # What is NOT verified here
 *
 * `PanResponder` cannot be driven meaningfully in jsdom — jsdom reads style
 * objects, not layout, and there is no touch pipeline. So the *decision*
 * (`swipeOutcome`) is a pure function with its own exhaustive suite, and this
 * component is the thin part: it forwards `(dx, dy, vx)` and animates. The
 * animation and the responder itself are unverified until they run on a device;
 * the task report says so rather than implying otherwise.
 */

import { useRef } from "react";
import { Animated, PanResponder, View, type ViewStyle } from "react-native";

import { useReducedMotion } from "../../app/motion.ts";
import { useTheme } from "../../app/Theme.tsx";
import { COMMIT_PX, swipeOutcome } from "../../lib/review.ts";

export interface SwipeCardProps {
  children: React.ReactNode;
  onConfirm: () => void;
  onSkip: () => void;
  /** Off for cards whose answer is not a yes/no — the unparsed entry form. */
  enabled?: boolean;
  style?: ViewStyle;
}

export function SwipeCard({ children, onConfirm, onSkip, enabled = true, style }: SwipeCardProps) {
  const t = useTheme();
  const reduced = useReducedMotion();
  const pan = useRef(new Animated.ValueXY()).current;

  const responder = useRef(
    PanResponder.create({
      // Claimed only once the finger has actually travelled, so a tap on a
      // category tile inside the card still reaches the tile.
      onMoveShouldSetPanResponder: (_e, g) => enabled && Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy),
      onPanResponderMove: Animated.event([null, { dx: pan.x }], { useNativeDriver: false }),
      onPanResponderRelease: (_e, g) => {
        const outcome = swipeOutcome({ dx: g.dx, dy: g.dy, vx: g.vx });
        const settle = () => {
          if (reduced) {
            pan.setValue({ x: 0, y: 0 });
            return;
          }
          Animated.spring(pan, { toValue: { x: 0, y: 0 }, useNativeDriver: false, speed: 20, bounciness: 4 }).start();
        };
        if (outcome === "confirm") onConfirm();
        else if (outcome === "skip") onSkip();
        settle();
      },
      onPanResponderTerminate: () => pan.setValue({ x: 0, y: 0 }),
    }),
  ).current;

  return (
    <View style={{ overflow: "hidden" }}>
      {/*
        The rails under the card. They are what tells a user the gesture
        exists at all — v1's audit found unlabelled rails invisible on the dark
        ground, so these carry words rather than only colour.
      */}
      <Animated.View
        style={[
          {
            backgroundColor: t.colors.surface,
            borderRadius: t.radius.lg,
            transform: [
              { translateX: pan.x.interpolate({ inputRange: [-COMMIT_PX * 2, 0, COMMIT_PX * 2], outputRange: [-COMMIT_PX * 2, 0, COMMIT_PX * 2], extrapolate: "clamp" }) },
            ],
          },
          style,
        ]}
        {...responder.panHandlers}
      >
        {children}
      </Animated.View>
    </View>
  );
}

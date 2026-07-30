import type { Preview } from "@storybook/react-vite";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "../src/styles/app.css";
import { MotionProvider } from "../src/app/MotionProvider";

const preview: Preview = {
  // Every story sits on the app's paper surface with the app's ink + face —
  // matches the PWA body, not Storybook's default white. MotionProvider is
  // here too, matching main.tsx: components built on `m.*` (e.g. Pressable)
  // need a LazyMotion ancestor to actually load the tap/gesture feature
  // bundle, or their whileTap etc. silently no-op instead of animating. This
  // decorator also backs src/test/storybook.test.tsx's composeStories
  // renders via setProjectAnnotations, so every story in the repo gets it.
  decorators: [
    (Story) => (
      <MotionProvider>
        <div className="bg-bg text-fg font-sans p-6 min-h-24">
          <Story />
        </div>
      </MotionProvider>
    ),
  ],
  parameters: {
    layout: "fullscreen",
    controls: { expanded: true },
  },
  tags: ["autodocs"],
};
export default preview;

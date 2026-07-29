import type { Preview } from "@storybook/react-vite";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "../src/styles/app.css";

const preview: Preview = {
  // Every story sits on the app's paper surface with the app's ink + face —
  // matches the PWA body, not Storybook's default white.
  decorators: [
    (Story) => (
      <div className="bg-bg text-fg font-sans p-6 min-h-24">
        <Story />
      </div>
    ),
  ],
  parameters: {
    layout: "fullscreen",
    controls: { expanded: true },
  },
  tags: ["autodocs"],
};
export default preview;

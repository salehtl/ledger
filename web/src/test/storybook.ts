// Side-effect import for *.stories.test.tsx files: applies .storybook/preview
// annotations (the paper-surface decorator) to composeStories renders, once.
import { beforeAll } from "vitest";
import { setProjectAnnotations } from "@storybook/react-vite";
import preview from "../../.storybook/preview";

const annotations = setProjectAnnotations([preview]);
beforeAll(annotations.beforeAll);

import type { StorybookConfig } from "@storybook/react-vite";
import remarkGfm from "remark-gfm";

const config: StorybookConfig = {
  stories: ["../src/**/*.mdx", "../src/**/*.stories.@(ts|tsx)"],
  addons: [
    {
      // MDX3 drops GFM syntax (pipe tables) unless remark-gfm is wired in —
      // Foundations.mdx's type table needs it.
      name: "@storybook/addon-docs",
      options: { mdxPluginOptions: { mdxCompileOptions: { remarkPlugins: [remarkGfm] } } },
    },
    "@storybook/addon-a11y",
  ],
  framework: { name: "@storybook/react-vite", options: {} },
  // The project vite config is merged in automatically (tailwind v4 plugin
  // included — that's how the tokens render). vite-plugin-pwa registers
  // virtual modules and a SW build step that break the storybook build, so
  // strip every plugin it contributes ("vite-plugin-pwa", "vite-plugin-pwa:build", …).
  viteFinal: (cfg) => {
    cfg.plugins = (cfg.plugins ?? [])
      .flat(Infinity)
      .filter((p) => !(p && typeof p === "object" && "name" in p && String(p.name).startsWith("vite-plugin-pwa")));
    return cfg;
  },
};
export default config;

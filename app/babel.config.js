// The worklets plugin MUST be last in the plugin list — it rewrites function
// bodies that other plugins have already finished with, and running it earlier
// silently produces worklets that capture the wrong scope.
//
// Reanimated 4 moved the plugin into `react-native-worklets`;
// `react-native-reanimated/plugin` is now a one-line re-export of it
// (`node_modules/react-native-reanimated/plugin/index.js`). The real name is
// used here so the indirection is not load-bearing.
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
    plugins: ["react-native-worklets/plugin"],
  };
};

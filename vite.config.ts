import { defineConfig } from "vite-plus";
import devServer from "@hono/vite-dev-server";

export default defineConfig({
  plugins: [
    devServer({
      entry: "src/index.ts",
    }),
  ],
  pack: {
    entry: ["src/index.ts"],
    format: ["esm"],
    deps: {
      alwaysBundle: [/.*/],
      onlyBundle: false,
    },
  },
  staged: {
    "*": "vp check --fix",
  },
  fmt: {},
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
});

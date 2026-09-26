import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/build.ts", "src/cleanup.ts"],
  platform: "node",
  target: "node24",
  format: "esm",
  outExtensions: () => ({ js: ".mjs" }),
  deps: { alwaysBundle: [/.*/], onlyBundle: false, onlyImport: [] },
  dts: false,
  clean: true,
  treeshake: true,
  minify: true,
});

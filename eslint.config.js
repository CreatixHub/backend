// @ts-check
const js = require("@eslint/js");
const tseslint = require("typescript-eslint");
const eslintConfigPrettier = require("eslint-config-prettier");

module.exports = tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "coverage/**", "release/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // this file itself: plain Node CommonJS, not part of the TypeScript program
    files: ["eslint.config.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { require: "readonly", module: "writable", __dirname: "readonly" },
    },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    rules: {
      // the codebase names unused request/response params intentionally (e.g. `_req`, `_res`)
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
  {
    // CLI scripts, not request-handling code: plain stdout output is normal here, not a missed logger.call
    files: ["src/seed.ts"],
    rules: { "no-console": "off" },
  },
  eslintConfigPrettier,
);

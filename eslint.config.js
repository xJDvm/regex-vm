// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "playground/dist/**",
      "coverage/**",
      "test-results/**",
      "playwright-report/**",
      "node_modules/**",
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
);

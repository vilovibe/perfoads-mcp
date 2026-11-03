import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    // The check engine is ported code that reads untyped snapshot rows (`Row`) and
    // indexes arrays right after a length or regex check; every field it reads is
    // coerced and null-checked at the read site.
    // The product exclusion tree planner and label simulation are ported the same way.
    files: [
      "packages/checks/src/engine/**/*.ts",
      "packages/checks/src/testing/**/*.ts",
      "packages/changes/src/productExclusion/**/*.ts",
    ],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: { globals: { console: "readonly", process: "readonly" } },
  },
);

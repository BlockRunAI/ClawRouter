import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/", "node_modules/", "test/"],
  },
  {
    // Build and maintenance scripts run directly under Node (no TypeScript to
    // supply its globals), so `console`, `process`, `fetch` etc. must be declared.
    files: ["scripts/**/*.{js,mjs,cjs}"],
    languageOptions: { globals: globals.node },
  },
);

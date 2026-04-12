import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      "dist/",
      "node_modules/",
      "coverage/",
      "**/bundle/",
      "**/vendor/",
      "**/*.min.js",
    ],
  },
  // Node.js globals (process, Buffer, console, URL, etc.) for .mjs/.cjs
  // scripts. Without this, the base `no-undef` rule flags every Node
  // built-in as undefined.
  {
    files: ["**/*.mjs", "**/*.cjs", "**/*.js"],
    languageOptions: {
      globals: globals.node,
    },
  },
  // TypeScript's own compiler already checks for undefined variables,
  // so the base ESLint `no-undef` rule produces false positives on
  // type annotations, interfaces, enums, and namespace imports.
  // See: https://typescript-eslint.io/troubleshooting/faqs/eslint
  {
    files: ["**/*.ts", "**/*.mts"],
    rules: {
      "no-undef": "off",
    },
  },
  // Test files intentionally use `any` for invalid-input edge cases.
  // Downgrade to warn so the quality gate doesn't block on test
  // ergonomics.
  {
    files: ["**/*.test.ts", "**/*.test.mts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": "warn",
      "no-empty": "warn",
      "no-useless-assignment": "warn",
    },
  },
  // Hook scripts and CLI tools use try/catch probes where the error
  // is intentionally discarded (file-existence checks, JSON parsing
  // fallbacks). These are false positives for `preserve-caught-error`
  // and `no-empty`, and `no-useless-assignment` fires on intentional
  // null-init-then-reassign patterns inside try/catch.
  {
    files: ["**/*.mjs", "**/*.cjs"],
    rules: {
      "preserve-caught-error": "warn",
      "no-empty": "warn",
      "no-useless-assignment": "warn",
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
);

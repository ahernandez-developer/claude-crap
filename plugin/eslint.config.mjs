import js from "@eslint/js";
import globals from "globals";

export default [
  js.configs.recommended,
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
  {
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      "preserve-caught-error": "warn",
      "no-empty": "warn",
      "no-useless-assignment": "warn",
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
];

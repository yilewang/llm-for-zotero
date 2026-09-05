// @ts-check Let TS check this config file

import zotero from "@zotero-plugin/eslint-config";

export default zotero({
  overrides: [
    {
      files: ["**/*.ts"],
      rules: {
        // We disable this rule here because the template
        // contains some unused examples and variables
        "@typescript-eslint/no-unused-vars": "off",
        // Control-character ranges are intentional in text sanitizers.
        "no-control-regex": "off",
      },
    },
    {
      files: ["scripts/**/*.cjs", "scripts/**/*.mjs"],
      languageOptions: {
        globals: {
          console: "readonly",
          process: "readonly",
        },
      },
    },
    {
      files: [
        "test/**/*.test.ts",
        "test-workflows/**/*.test.ts",
        "test-live-workflows/**/*.test.ts",
        "test-live-agent/**/*.test.ts",
      ],
      rules: {
        // Static fixture construction at module scope is deliberate in these tests.
        "mocha/consistent-spacing-between-blocks": "off",
        "mocha/max-top-level-suites": "off",
        "mocha/no-setup-in-describe": "off",
        "@typescript-eslint/no-this-alias": "off",
      },
    },
    {
      files: [
        "src/hooks.ts",
        "src/modules/contextPanel/setupHandlers/controllers/menuActionController.ts",
      ],
      rules: {
        // These late imports avoid loading optional/circular shutdown and UI modules.
        "@typescript-eslint/no-require-imports": "off",
      },
    },
  ],
});

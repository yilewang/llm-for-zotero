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
      files: ["src/agent/model/**/*.ts", "src/utils/providerConnectionTest.ts"],
      rules: {
        "no-restricted-syntax": [
          "error",
          {
            selector: "CallExpression[callee.name=/^(fetch|fetchFn)$/]",
            message:
              "Model requests must use sendProviderRequest so provider requirements cannot be bypassed.",
          },
          {
            selector:
              "CallExpression[callee.type='CallExpression'][callee.callee.name='getFetch']",
            message:
              "Model requests must use sendProviderRequest so provider requirements cannot be bypassed.",
          },
          {
            selector:
              "CallExpression[callee.type='MemberExpression'][callee.property.name=/^(fetch|fetchFn)$/]",
            message:
              "Model requests must use sendProviderRequest so provider requirements cannot be bypassed.",
          },
        ],
      },
    },
    {
      files: ["src/utils/llmClient.ts"],
      rules: {
        "no-restricted-syntax": [
          "error",
          {
            selector:
              "FunctionDeclaration[id.name=/^(callLLM|callLLMStream|callNativeProtocol|postWithTemperatureFallback|postWithReasoningFallback)$/] CallExpression[callee.type='CallExpression'][callee.callee.name='getFetch']",
            message:
              "Model inference must pass through sendProviderRequest, including retries.",
          },
        ],
      },
    },
    {
      // Chrome scripts loaded directly by the standalone XHTML documents. They
      // run in a privileged window, not through the bundler.
      files: ["addon/content/**/*.js"],
      languageOptions: {
        globals: {
          ChromeUtils: "readonly",
          console: "readonly",
          document: "readonly",
          window: "readonly",
        },
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
        "test-live-runtimes/**/*.test.ts",
        "test-db-upgrade/**/*.test.ts",
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

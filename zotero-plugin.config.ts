import { cp } from "node:fs/promises";
import { defineConfig } from "zotero-plugin-scaffold";
import pkg from "./package.json";
import { patchGeneratedWorkflowTestReporter } from "./scripts/workflow-test-reporter.mjs";

const webChatLiveTestsEnabled = process.env.LLM_FOR_ZOTERO_WEBCHAT_LIVE === "1";
// Live agent tests call a real model with the user's own credentials, so they
// are opt-in: they cost money and need network, which a default test run
// should never assume.
const agentLiveTestsEnabled = process.env.LLM_FOR_ZOTERO_AGENT_LIVE === "1";
const workflowTestsEnabled =
  webChatLiveTestsEnabled ||
  agentLiveTestsEnabled ||
  process.env.LLM_FOR_ZOTERO_WORKFLOW_TESTS === "1";

export default defineConfig({
  source: ["src", "addon"],
  dist: ".scaffold/build",
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,
  updateURL: `https://github.com/{{owner}}/{{repo}}/releases/download/release/${
    pkg.version.includes("-") ? "update-beta.json" : "update.json"
  }`,
  xpiDownloadLink:
    "https://github.com/{{owner}}/{{repo}}/releases/download/v{{version}}/{{xpiName}}.xpi",

  build: {
    assets: ["addon/**/*.*"],
    define: {
      ...pkg.config,
      author: pkg.author,
      description: pkg.description,
      homepage: pkg.homepage,
      buildVersion: pkg.version,
      buildTime: "{{buildTime}}",
    },
    fluent: {
      prefixFluentMessages: false,
    },
    prefs: {
      prefix: pkg.config.prefsPrefix,
    },
    esbuildOptions: [
      {
        entryPoints: ["src/index.ts"],
        define: {
          __env__: `"${process.env.NODE_ENV}"`,
          __behaviorSuiteRequest__: JSON.stringify(
            process.env.LLM_FOR_ZOTERO_BEHAVIOR_REQUEST || "",
          ),
        },
        bundle: true,
        target: "firefox115",
        loader: { ".md": "text" },
        outfile: `.scaffold/build/addon/content/scripts/${pkg.config.addonRef}.js`,
      },
      {
        entryPoints: ["src/utils/pdfSplitterWorker.ts"],
        bundle: true,
        target: "firefox115",
        outfile: ".scaffold/build/addon/content/scripts/pdfSplitterWorker.js",
      },
    ],
  },

  test: {
    entries:
      process.env.LLM_FOR_ZOTERO_TEST_ENTRIES ||
      (agentLiveTestsEnabled
        ? "test-live-agent"
        : webChatLiveTestsEnabled
          ? "test-live-workflows"
          : workflowTestsEnabled
            ? "test-workflows"
            : "test"),
    ...(workflowTestsEnabled
      ? {
          abortOnFail: !agentLiveTestsEnabled,
          // A live agent turn does real model round trips and real library
          // writes, so it needs far longer than a UI workflow test.
          mocha: {
            timeout:
              webChatLiveTestsEnabled || agentLiveTestsEnabled ? 720000 : 30000,
          },
          watch: false,
        }
      : {}),
    hooks: {
      "test:init": async () => {
        if (process.env.LLM_FOR_ZOTERO_MINERU_RESTART_PHASE === "resume") {
          await cp(
            ".scaffold/mineru-restart/data-snapshot",
            ".scaffold/test/data",
            { recursive: true },
          );
        }
        // A live QA run can answer from a copy of the user's own data
        // directory (zotero.sqlite, storage, MinerU and embedding caches)
        // instead of the empty scaffold profile. The copy is what the run
        // writes to, so the original library is never touched.
        const snapshot = process.env.LLM_FOR_ZOTERO_QA_DATA_SNAPSHOT;
        if (snapshot) {
          await cp(snapshot, ".scaffold/test/data", { recursive: true });
        }
        // Test-only: a run can start from a saved profile prefs.js, such as
        // the one an earlier phase of a DB upgrade test left behind. The
        // scaffold keeps the prefs it finds in the profile and adds its own.
        const prefsSnapshot = process.env.LLM_FOR_ZOTERO_PROFILE_PREFS_SNAPSHOT;
        if (prefsSnapshot) {
          await cp(prefsSnapshot, ".scaffold/test/profile/prefs.js");
        }
      },
      "test:bundleTests": () => patchGeneratedWorkflowTestReporter(),
    },
    waitForPlugin: `() => Zotero.${pkg.config.addonInstance}.data.initialized`,
  },

  // If you need to see a more detailed log, uncomment the following line:
  // logLevel: "trace",
});

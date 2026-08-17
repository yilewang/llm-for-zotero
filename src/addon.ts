import { config } from "../package.json";
import { ColumnOptions, DialogHelper } from "zotero-plugin-toolkit";
import hooks from "./hooks";
import { createZToolkit } from "./utils/ztoolkit";
import type { getAgentApi } from "./agent";
import type { WorkflowTestApi } from "./modules/contextPanel/workflowTestTypes";
import type {
  BackfillOptions,
  BackfillResult,
} from "./agent/actions/backfillPageInfo";
import { backfillPageInfo } from "./agent/actions/backfillPageInfo";

class Addon {
  public data: {
    alive: boolean;
    config: typeof config;
    // Env type, see build.js
    env: "development" | "production" | "test";
    initialized?: boolean;
    ztoolkit: ZToolkit;
    locale?: {
      current: any;
    };
    prefs?: {
      window: Window;
      columns: Array<ColumnOptions>;
      rows: Array<{ [dataKey: string]: string }>;
    };
    dialogs: Set<DialogHelper>;
    standaloneWindow?: Window;
  };
  // Lifecycle hooks
  public hooks: typeof hooks;
  // APIs
  public api: {
    agent?: ReturnType<typeof getAgentApi>;
    workflowTest?: WorkflowTestApi;
    backfillPageInfo?: (options?: BackfillOptions) => Promise<BackfillResult>;
  };

  constructor() {
    this.data = {
      alive: true,
      config,
      env: __env__,
      initialized: false,
      ztoolkit: createZToolkit(),
      dialogs: new Set(),
    };
    this.hooks = hooks;
    this.api = {
      get backfillPageInfo() {
        // Replace the getter with the real function on first access.
        Object.defineProperty(this, "backfillPageInfo", {
          value: backfillPageInfo,
          configurable: true,
          enumerable: true,
          writable: true,
        });
        return backfillPageInfo;
      },
    } as any;
  }
}

export default Addon;

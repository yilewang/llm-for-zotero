import { ZoteroToolkit } from "zotero-plugin-toolkit";
import { config } from "../../package.json";
import { appLogger, formatAppLogError, setAppLogSink } from "../core/logging";

export { createZToolkit, disposeAppLogging, installAppLogging };

type LogToolkit = {
  log: (...args: unknown[]) => unknown;
};

function isErrorValue(value: unknown): value is {
  name?: unknown;
  message?: unknown;
  stack?: unknown;
} {
  return (
    value instanceof Error ||
    Object.prototype.toString.call(value) === "[object Error]"
  );
}

function installAppLogging(toolkit: LogToolkit): void {
  const writeToolkitLog = toolkit.log.bind(toolkit);
  setAppLogSink((_level, args) =>
    writeToolkitLog(
      ...args.map((arg) => (isErrorValue(arg) ? formatAppLogError(arg) : arg)),
    ),
  );
  toolkit.log = (...args: unknown[]) => appLogger.debug(...args);
}

function createZToolkit() {
  const _ztoolkit = new ZoteroToolkit();
  /**
   * Alternatively, import toolkit modules you use to minify the plugin size.
   * You can add the modules under the `MyToolkit` class below and uncomment the following line.
   */
  // const _ztoolkit = new MyToolkit();
  initZToolkit(_ztoolkit);
  return _ztoolkit;
}

function initZToolkit(_ztoolkit: ReturnType<typeof createZToolkit>) {
  const env = __env__;
  _ztoolkit.basicOptions.log.prefix = `[${config.addonName}]`;
  _ztoolkit.basicOptions.log.disableConsole = env === "production";
  _ztoolkit.UI.basicOptions.ui.enableElementJSONLog = __env__ === "development";
  _ztoolkit.UI.basicOptions.ui.enableElementDOMLog = __env__ === "development";
  // Getting basicOptions.debug will load global modules like the debug bridge.
  // since we want to deprecate it, should avoid using it unless necessary.
  // _ztoolkit.basicOptions.debug.disableDebugBridgePassword =
  //   __env__ === "development";
  _ztoolkit.basicOptions.api.pluginID = config.addonID;
  _ztoolkit.ProgressWindow.setIconURI(
    "default",
    `chrome://${config.addonRef}/content/icons/icon.svg`,
  );

  // The toolkit compatibility entry point is diagnostic. Application source
  // uses explicit facade methods for warning, lifecycle, and trace severity.
  installAppLogging(_ztoolkit);
}

function disposeAppLogging(): void {
  setAppLogSink(null);
}

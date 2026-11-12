import {
  archiveCodexAppServerThread,
  forkCodexAppServerThreadWithRecord,
} from "./nativeClient";

export type CodexAppServerForkService = {
  /** The fork's thread and the permission record its conversation stores. */
  forkThread: typeof forkCodexAppServerThreadWithRecord;
  archiveThread: typeof archiveCodexAppServerThread;
};

export const codexAppServerForkService: CodexAppServerForkService = {
  forkThread: forkCodexAppServerThreadWithRecord,
  archiveThread: archiveCodexAppServerThread,
};

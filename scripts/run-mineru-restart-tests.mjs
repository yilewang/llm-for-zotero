import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { runMineruRestartPhase } from "./mineru-restart-phase.mjs";

// The standard scaffold empties its disposable data directory on every run.
// Preserve its stopped database and checkpoint files between two fresh Zotero
// processes so this tests disk recovery, not module-level state.
const root = ".scaffold/mineru-restart";
const entries = `${root}/tests`;
await mkdir(entries, { recursive: true });
const helper = "../../../test-workflows/helpers/mineruRecoveryScenario";
async function phase(name, test) {
  await writeFile(
    `${entries}/restart.test.ts`,
    `import { assert } from "chai";
import { interruptRecoveryScenario, resumeRecoveryScenario, cleanupRecoveryScenario, disposeRecoveryScenarioResources } from "${helper}";
describe("MinerU process restart: ${name}",function(){this.timeout(120000);
after(disposeRecoveryScenarioResources);
it("${name}",async function(){
const io=(globalThis as any).IOUtils;
const recordPath=PathUtils.join(Zotero.DataDirectory.dir,"mineru-restart-records.json");
${test}
});});\n`,
  );
  await runMineruRestartPhase(name, {
    env: {
      ...process.env,
      LLM_FOR_ZOTERO_TEST_ENTRIES: entries,
      LLM_FOR_ZOTERO_MINERU_RESTART_PHASE: name,
    },
  });
}
await phase(
  "interrupt",
  `const records=[];
for(const mode of ["cancel","quota"] as const) records.push(await interruptRecoveryScenario(mode));
await io.write(recordPath,new TextEncoder().encode(JSON.stringify(records)),{flush:true});`,
);
await rm(`${root}/data-snapshot`, { recursive: true, force: true });
await cp(".scaffold/test/data", `${root}/data-snapshot`, { recursive: true });
await phase(
  "resume",
  `const records=JSON.parse(new TextDecoder().decode(await io.read(recordPath)));
assert.lengthOf(records,2);
for(const record of records) {await resumeRecoveryScenario(record);await cleanupRecoveryScenario(record);}
await io.remove(recordPath);`,
);
await rm(`${root}/data-snapshot`, { recursive: true, force: true });
console.log(
  "Verified cancellation and quota recovery across separate Zotero processes.",
);

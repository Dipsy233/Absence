/**
 * Pull the official ACP agent registry into ~/.absence/registry.json.
 *
 *   npm run registry:sync
 *
 * The runtime picker reads this cache through AgentCatalog.listProfiles(), so
 * after a successful sync any new ACP agent appears there without a restart.
 * Offline / HTTP / malformed-body failures print the URL and exit 1; the
 * existing cache is left untouched.
 */
import os from "node:os";
import path from "node:path";
import { listProfiles, syncRegistry } from "../../apps/server/src/agents/acp/AgentCatalog";

async function main(): Promise<void> {
  const dir = path.join(os.homedir(), ".absence");
  try {
    const count = await syncRegistry({ dir });
    const registryProfiles = listProfiles().filter((profile) => profile.source === "registry");
    console.log(`ACP registry: ${count} agents cached in ${path.join(dir, "registry.json")}`);
    console.log(`Picker will show ${registryProfiles.length} registry profile(s):`);
    for (const profile of registryProfiles) {
      console.log(`  ${profile.id}  ${profile.label}  ${profile.launch.command} ${(profile.launch.args ?? []).join(" ")}`);
    }
  } catch (error) {
    console.error(`ACP registry sync failed: ${error instanceof Error ? error.message : String(error)}`);
    console.error("Absence keeps working offline; the previous cache (if any) was not changed.");
    process.exit(1);
  }
}

void main();

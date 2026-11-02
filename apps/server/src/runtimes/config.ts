import {
  launchLine,
  launchOverrides,
  listProfiles,
  missingProfileCommands,
  writeLaunchOverrides,
  type CatalogEntry,
} from "../agents/acp/AgentCatalog";
import { registeredRuntimes } from "../agents/registry";
import type { RuntimeStatus } from "@absence/core";

export type { RuntimeStatus };

/* ══════════════════════════════════════════════════════════════════════════
   Runtime configuration — the launch lines the agent profiles use, editable
   from the Project Picker so a missing/incorrectly-pathed runtime can be fixed
   without editing environment variables or restarting.

   Persisted to ~/.absence/runtimes.json as a map from profile id to a launch
   line (`command args…`). There are no per-product fields here: the list is
   whatever the catalog knows, and a new agent adds data, not a key in this
   file. Env vars still seed the shipped profiles; a saved value overrides them
   and survives a restart, so the picker is the single place to edit launches.
   ══════════════════════════════════════════════════════════════════════════ */

export interface RuntimePaths {
  /** Profile id → launch line. An empty line clears the override. */
  launch: Record<string, string>;
}

/** The saved overrides as the picker and profile resolver see them. */
export function runtimePaths(): RuntimePaths {
  return { launch: launchOverrides() };
}

/** Save launch lines; the catalog reads them at the next session start. */
export function setRuntimePaths(patch: RuntimePaths): RuntimePaths {
  const current = { ...launchOverrides() };
  for (const [id, value] of Object.entries(patch.launch ?? {})) {
    const line = typeof value === "string" ? value.trim() : "";
    if (line) current[id] = line;
    else delete current[id];
  }
  writeLaunchOverrides(current);
  return { launch: current };
}

/** A picker row with the profile-only facts the launch editor needs. */
export interface ProfileRuntimeStatus extends RuntimeStatus {
  /** The profile id (same as `kind`, kept explicit for the picker). */
  profileId: string;
  /** `command args…`, the editable launch line. */
  commandLine: string;
  /** Whether the agent may refuse `session/new` until it authenticates. */
  auth?: "none" | "optional" | "required";
  capabilities?: string;
  requires?: string[];
  source: CatalogEntry["source"];
}

/**
 * Every runtime, with an availability verdict for the picker.
 *
 * One row per catalog profile — no product is written down here. A runtime
 * adapter registered without a profile (the mock, or a host's own) gets a row
 * too, so the list is genuinely "what can run", not a copy of a hard-coded
 * roster.
 */
export function runtimeStatuses(): RuntimeStatus[] {
  const profiles = listProfiles().filter((profile) => profile.source !== "fixture");
  const statuses: ProfileRuntimeStatus[] = profiles.map(profileStatus);

  const known = new Set<string>();
  for (const profile of profiles) {
    known.add(profile.id);
    for (const alias of profile.aliases ?? []) known.add(alias);
  }
  for (const kind of registeredRuntimes()) {
    if (known.has(kind)) continue;
    statuses.push({
      kind,
      label: kind,
      available: true,
      configurable: false,
      note: "registered adapter (no ACP profile)",
      profileId: kind,
      commandLine: "",
      source: "builtin",
    });
  }
  return statuses;
}

function profileStatus(profile: CatalogEntry): ProfileRuntimeStatus {
  const line = launchLine(profile);
  const missing = missingProfileCommands(profile);
  const notes = [profile.note, profile.capabilities];
  if (profile.auth === "required") {
    notes.push(
      "sign-in required — the agent may refuse session/new until its own authenticate method succeeds; Absence forwards that request and never reads credentials",
    );
  } else if (profile.auth === "optional") {
    notes.push("sign-in may be requested by the agent");
  }
  notes.push(`launch: ${line}`);
  if (missing.length > 0) notes.push(`missing: ${missing.join(", ")}`);
  return {
    kind: profile.id,
    label: profile.label,
    available: missing.length === 0,
    configurable: profile.configurable === true,
    path: line,
    note: notes.filter(Boolean).join(" · ") || "ACP profile",
    profileId: profile.id,
    commandLine: line,
    auth: profile.auth,
    capabilities: profile.capabilities,
    requires: profile.requires,
    source: profile.source,
  };
}

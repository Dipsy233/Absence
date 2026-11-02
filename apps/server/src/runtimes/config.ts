import {
  launchLine,
  launchOverrides,
  listProfiles,
  writeLaunchOverrides,
  type AgentAuthStatus,
  type AgentModels,
  type AgentReadiness,
  type CatalogEntry,
  type LaunchOrigin,
} from "../agents/acp/AgentCatalog";
import type { AgentAuthMode } from "../agents/acp/profiles";
import { registeredRuntimes } from "../agents/registry";
import type { RuntimeStatus } from "@absence/core";

export type { RuntimeStatus };

/* ══════════════════════════════════════════════════════════════════════════
   Runtime configuration — which ACP entries this machine has, and the launch
   lines the user may override from the Project Picker.

   Persisted to ~/.absence/agents.json (Absence's own file; a legacy
   ~/.absence/runtimes.json is still read, never rewritten). There are no
   per-product fields here: the list is whatever the catalog discovered, and a
   new agent adds data, not a key in this file.
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
  /** Ready / needs-adapter / needs-auth / unavailable, with one sentence. */
  state: AgentReadiness;
  stateReason: string;
  /** Auto-discovered, manually configured, or a user override. */
  source: LaunchOrigin;
  /** The executable or node_modules entry discovery landed on. */
  discoveredFrom?: string;
  /** Auth conclusion read from the agent's own config, or unknown. */
  auth: AgentAuthStatus;
  authReason: string;
  /** The agent's declared sign-in expectation. */
  authHint?: AgentAuthMode;
  /** The agent's declared models; ACP session models win when available. */
  models: AgentModels;
  /** True when launching would download a package (npx opt-in only). */
  willDownload?: boolean;
  /** What to install to make a non-ready row startable. */
  installHint?: string;
  capabilities?: string;
  requires?: string[];
}

/**
 * Every runtime, with a readiness verdict for the picker.
 *
 * One row per catalog entry — no product is written down here. A runtime
 * adapter registered without a profile (the mock, or a host's own) gets a row
 * too, so the list is genuinely "what can run", not a copy of a hard-coded
 * roster.
 *
 * `liveModels` carries models an ACP session reported for a runtime
 * (`session/new` / `config_option_update`). They override the static list read
 * from the agent's own config, because the agent is the authority once it is
 * connected.
 */
export function runtimeStatuses(liveModels?: Record<string, string>): ProfileRuntimeStatus[] {
  const profiles = listProfiles().filter((profile) => profile.source !== "fixture");
  const statuses: ProfileRuntimeStatus[] = profiles.map((profile) =>
    profileStatus(profile, liveModels?.[profile.id]),
  );

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
      state: "ready",
      stateReason: "registered adapter (no ACP profile)",
      source: "auto",
      auth: "unknown",
      authReason: "no agent config; sign-in status unknown",
      models: { state: "unknown", items: [] },
    });
  }
  return statuses;
}

function profileStatus(profile: CatalogEntry, sessionModel?: string): ProfileRuntimeStatus {
  const line = launchLine(profile);
  const notes = [profile.note, profile.capabilities];
  notes.push(profile.stateReason);
  if (profile.models.items.length > 0) {
    notes.push(`models: ${profile.models.items.join(", ")}`);
  } else if (profile.models.state === "empty") {
    notes.push("agent has not declared any models");
  } else if (profile.models.state === "unknown") {
    notes.push("model list unknown (agent config unreadable)");
  }
  notes.push(`launch: ${line}`);
  if (profile.willDownload) notes.push("will download a package temporarily on launch");
  if (profile.installHint) notes.push(profile.installHint);
  const models: AgentModels = sessionModel ? { state: "session", items: [sessionModel] } : profile.models;
  return {
    kind: profile.id,
    label: profile.label,
    available: profile.state === "ready",
    configurable: profile.configurable === true,
    path: line,
    note: notes.filter(Boolean).join(" · ") || "ACP profile",
    profileId: profile.id,
    commandLine: line,
    state: profile.state,
    stateReason: profile.stateReason,
    source: profile.origin,
    ...(profile.discoveredFrom ? { discoveredFrom: profile.discoveredFrom } : {}),
    auth: profile.authStatus,
    authReason: profile.authReason,
    ...(profile.auth ? { authHint: profile.auth } : {}),
    models,
    ...(profile.willDownload ? { willDownload: true } : {}),
    ...(profile.installHint ? { installHint: profile.installHint } : {}),
    ...(profile.capabilities ? { capabilities: profile.capabilities } : {}),
    ...(profile.requires ? { requires: profile.requires } : {}),
  };
}

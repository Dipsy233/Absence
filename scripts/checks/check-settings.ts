/**
 * The settings store's loading and normalising rules.
 *   npx tsx scripts/check-settings.ts
 *
 * Bug 1 lived here: all three thresholds shared one fallback, so clearing the
 * "no activity for" box restored 5 *seconds* instead of 3600 and the streak box
 * restored 5 instead of 3. The per-field defaults are pinned below, along with
 * the junk-value handling a stale localStorage entry needs.
 */
import { check, finish } from "./harness";
import { normalizeSettings } from "../../apps/web/src/stores/settingsStore";

// The store module reads localStorage at import time; give it a minimal stub so
// the import works outside a browser.
const g = globalThis as unknown as { localStorage?: unknown };
g.localStorage ??= {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

// A. an empty object is the full default set.
{
  const s = normalizeSettings({});
  check("empty input → default language", s.language === "en");
  check("empty input → 5 failed commands", s.commandFailThreshold === 5);
  check("empty input → 3 back-to-back", s.commandStreakThreshold === 3);
  check("empty input → 3600s stall", s.activityStallThreshold === 3600);
  check("empty input → every rail panel present", s.railOrder.length === 3 && s.leftOrder.length === 3);
}

// B. the bug: each cleared field restores its OWN default, not the first one's.
{
  const s = normalizeSettings({
    commandFailThreshold: undefined,
    commandStreakThreshold: undefined,
    activityStallThreshold: undefined,
  });
  check("cleared stall field → 3600, not 5", s.activityStallThreshold === 3600, String(s.activityStallThreshold));
  check("cleared streak field → 3, not 5", s.commandStreakThreshold === 3, String(s.commandStreakThreshold));
  check("cleared fail field → 5", s.commandFailThreshold === 5, String(s.commandFailThreshold));
}

// C. junk values of every shape fall back rather than poisoning the engine.
{
  const junk = normalizeSettings({
    commandFailThreshold: 0,
    commandStreakThreshold: -4,
    activityStallThreshold: Number.NaN,
    fileVersionLoopThreshold: "7" as unknown as number,
    commandRetryLoopThreshold: 2.7,
    processLeftRunningMinSeconds: null as unknown as number,
    soundVolume: 999,
    soundVolumeBogus: 1,
  } as never);
  check("0 is not a threshold", junk.commandFailThreshold === 5);
  check("a negative threshold is not one", junk.commandStreakThreshold === 3);
  check("NaN falls back", junk.activityStallThreshold === 3600);
  check("a string is not a number", junk.fileVersionLoopThreshold === 1);
  check("a fractional threshold floors", junk.commandRetryLoopThreshold === 2);
  check("a null count falls back", junk.processLeftRunningMinSeconds === 0);
  check("volume is clamped to 100", junk.soundVolume === 100);
}

// D. zero is legal where the setting means "no minimum".
{
  check(
    "a lifetime of 0 is kept",
    normalizeSettings({ processLeftRunningMinSeconds: 0 }).processLeftRunningMinSeconds === 0,
  );
  check("a volume of 0 is kept", normalizeSettings({ soundVolume: 0 }).soundVolume === 0);
}

// E. levels: known values are kept, junk falls back to that field's default.
{
  const s = normalizeSettings({
    commandFailLevel: "high",
    outsideChangeLevel: "nonsense" as never,
    processLeftRunningLevel: "silent" as never,
  });
  check("a known level is kept", s.commandFailLevel === "high");
  check("an unknown level falls back", s.outsideChangeLevel === "low", String(s.outsideChangeLevel));
  check("an invalid level string falls back", s.processLeftRunningLevel === "high");
  check(
    "every new reason has a level",
    [
      s.agentStoppedLevel,
      s.unresolvedErrorLevel,
      s.processLeftRunningLevel,
      s.outsideChangeLevel,
      s.fileVersionLoopLevel,
      s.commandRetryLoopLevel,
    ].every((level) => ["none", "low", "medium", "high"].includes(level)),
  );
}

// F. list fields: trimmed, de-duplicated, junk dropped.
{
  const s = normalizeSettings({
    outsideChangeIgnore: ["  *.log  ", "*.log", "", "**/dist/**", 7 as unknown as string],
    processLeftRunningIgnore: "vite" as unknown as string[],
  });
  check("globs are trimmed and de-duplicated", s.outsideChangeIgnore.join("|") === "*.log|**/dist/**", s.outsideChangeIgnore.join("|"));
  check("a non-array list becomes empty", s.processLeftRunningIgnore.length === 0);
}

// G. rail orders: unknown ids dropped, missing ones appended, so every panel renders.
{
  const s = normalizeSettings({
    railOrder: ["eggs", "bogus" as never],
    leftOrder: ["activity", "files", "history", "files"],
  });
  check("an unknown rail id is dropped", !s.railOrder.includes("bogus" as never));
  check("a known rail id is kept and the rest appended", s.railOrder.join(",") === "eggs,agent,folder", s.railOrder.join(","));
  check("a complete left order is kept", s.leftOrder.join(",") === "activity,files,history", s.leftOrder.join(","));
}

finish();

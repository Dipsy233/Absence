/**
 * The chime rules, without an AudioContext.
 *   npx tsx scripts/checks/check-chimes.ts
 *
 * `attentionChimeFor` is the whole policy for when an attention change is
 * audible. It is pure so it can be pinned here: every branch below was a bug
 * once — a step into low rang when it should have been silent, or a release
 * out of high went quiet with it.
 */
import { check, finish } from "./harness";
import { attentionChimeFor } from "../../apps/web/src/lib/sounds";

const LEVELS = ["none", "low", "medium", "high"] as const;

// A. every step up rings at its own urgency.
check("none → medium rings medium", attentionChimeFor("none", "medium", false) === "medium");
check("none → high rings high", attentionChimeFor("none", "high", false) === "high");
check("low → medium rings medium", attentionChimeFor("low", "medium", false) === "medium");
check("low → high rings high", attentionChimeFor("low", "high", false) === "high");
check("medium → high rings high", attentionChimeFor("medium", "high", false) === "high");

// B. a step into low is silent unless asked for; the chime is the softer one.
check("none → low is silent by default", attentionChimeFor("none", "low", false) === undefined);
check("none → low rings when low is enabled", attentionChimeFor("none", "low", true) === "medium");
check(
  "medium → low is silent by default",
  attentionChimeFor("medium", "low", false) === undefined,
);
check(
  "medium → low rings when low is enabled",
  attentionChimeFor("medium", "low", true) === "medium",
);

// C. a release out of high is audible, so the user hears the run relax.
check("high → medium rings medium", attentionChimeFor("high", "medium", false) === "medium");
check("high → low rings when low is enabled", attentionChimeFor("high", "low", true) === "medium");
check("high → none rings medium", attentionChimeFor("high", "none", false) === "medium");

// D. a release that never touched high stays quiet, and so does no change.
check("medium → none is silent", attentionChimeFor("medium", "none", false) === undefined);
check("low → none is silent", attentionChimeFor("low", "none", false) === undefined);
for (const level of LEVELS) {
  check(`${level} → ${level} is silent`, attentionChimeFor(level, level, true) === undefined);
}

finish();

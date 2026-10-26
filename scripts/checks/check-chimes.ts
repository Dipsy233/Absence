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
check("none → medium rings medium", attentionChimeFor("none", "medium") === "medium");
check("none → high rings high", attentionChimeFor("none", "high") === "high");
check("low → medium rings medium", attentionChimeFor("low", "medium") === "medium");
check("low → high rings high", attentionChimeFor("low", "high") === "high");
check("medium → high rings high", attentionChimeFor("medium", "high") === "high");

// B. a step into low is always silent: low is where most runs sit for
//    harmless reasons, so it never rings.
check("none → low is silent", attentionChimeFor("none", "low") === undefined);
check("medium → low is silent", attentionChimeFor("medium", "low") === undefined);

// C. a release out of high is audible, so the user hears the run relax.
check("high → medium rings medium", attentionChimeFor("high", "medium") === "medium");
check("high → low rings medium", attentionChimeFor("high", "low") === "medium");
check("high → none rings medium", attentionChimeFor("high", "none") === "medium");

// D. a release that never touched high stays quiet, and so does no change.
check("medium → none is silent", attentionChimeFor("medium", "none") === undefined);
check("low → none is silent", attentionChimeFor("low", "none") === undefined);
for (const level of LEVELS) {
  check(`${level} → ${level} is silent`, attentionChimeFor(level, level) === undefined);
}

finish();

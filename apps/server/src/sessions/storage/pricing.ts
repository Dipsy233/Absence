/**
 * The token price table (`~/.absence/pricing.json`).
 *
 * Cost is derived at query time — tokens are the telemetry fact, price is a
 * user's local configuration, and storing a computed cost would bake one
 * moment's prices into data that outlives them. Each rule is a model glob
 * with USD-per-million-token rates; the first matching rule wins, so a
 * trailing `*` row works as a catch-all default.
 *
 * The file is read fresh on every stats query: editing it (in Settings, or by
 * hand) takes effect on the next refresh without a restart. A missing or
 * unreadable file prices nothing — the report shows "cost not configured",
 * never a made-up 0.
 */

import fs from "node:fs";
import path from "node:path";
import type { PricingRule } from "@absence/core";
import { stateRoot } from "./legacyPaths";

const PRICING_FILE = "pricing.json";

export function pricingFile(): string {
  return path.join(stateRoot(), PRICING_FILE);
}

/** The table as stored, validated leniently: junk rows are dropped, not fatal. */
export function readPricingConfig(): PricingRule[] {
  let text: string;
  try {
    text = fs.readFileSync(pricingFile(), "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.error("[absence] pricing.json is not valid JSON; pricing nothing");
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const rules: PricingRule[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const candidate = entry as Record<string, unknown>;
    const model = typeof candidate.model === "string" ? candidate.model.trim() : "";
    const input = Number(candidate.inputPer1M);
    const output = Number(candidate.outputPer1M);
    if (!model) continue;
    if (!Number.isFinite(input) || input < 0) continue;
    if (!Number.isFinite(output) || output < 0) continue;
    rules.push({ model, inputPer1M: input, outputPer1M: output });
  }
  return rules;
}

/** Replace the whole table. Throws with a readable message on bad input. */
export function writePricingConfig(rules: PricingRule[]): void {
  if (!Array.isArray(rules)) throw new Error("pricing rules must be an array");
  const cleaned: PricingRule[] = rules.map((rule, index) => {
    if (typeof rule?.model !== "string" || !rule.model.trim()) {
      throw new Error(`rule ${index}: "model" must be a non-empty glob`);
    }
    const input = Number(rule.inputPer1M);
    const output = Number(rule.outputPer1M);
    if (!Number.isFinite(input) || input < 0) {
      throw new Error(`rule ${index}: "inputPer1M" must be a number ≥ 0`);
    }
    if (!Number.isFinite(output) || output < 0) {
      throw new Error(`rule ${index}: "outputPer1M" must be a number ≥ 0`);
    }
    return { model: rule.model.trim(), inputPer1M: input, outputPer1M: output };
  });
  fs.mkdirSync(stateRoot(), { recursive: true });
  fs.writeFileSync(pricingFile(), `${JSON.stringify(cleaned, null, 2)}\n`, "utf8");
}

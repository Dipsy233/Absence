import type {
  ConfigOptionChoice,
  ConfigOptionGroup,
  ConfigOptionSnapshot,
  ConfigOptionValue,
} from "@absence/core";
import type { AcpConfigOption, AcpConnection } from "./AcpConnection";

/**
 * The agent's own selectors (model / mode / thought level / …).
 *
 * ACP owns this state. Absence stores the last array the agent reported —
 * `session/new` and every `config_option_update` replace it — and forwards a
 * user's choice verbatim. It never invents an option, a category or a value.
 */
export class AcpConfigOptions {
  private options: AcpConfigOption[] = [];

  /** Replace the state with what `session/new` (or a resume) returned. */
  fromSession(options: AcpConfigOption[] | undefined): void {
    this.options = Array.isArray(options) ? [...options] : [];
  }

  /**
   * Replace the state from `config_option_update`. Returns true when the
   * update actually carried an array, so the caller knows to refresh the UI.
   */
  fromUpdate(update: any): boolean {
    if (!Array.isArray(update?.configOptions)) return false;
    this.options = update.configOptions as AcpConfigOption[];
    return true;
  }

  /** The read-only view the port exposes. */
  snapshots(): ConfigOptionSnapshot[] {
    return this.options.map(toSnapshot);
  }

  /** An option by its own id or by its ACP category. */
  find(idOrCategory: string): AcpConfigOption | undefined {
    return this.options.find(
      (option) => option.id === idOrCategory || option.category === idOrCategory,
    );
  }

  /** Every selectable value of the model option, grouped when ACP groups it. */
  modelChoices(): Array<{ value: string; name?: string; description?: string; group?: string }> {
    const model = this.find("model");
    if (!model || !Array.isArray(model.options)) return [];
    const out: Array<{ value: string; name?: string; description?: string; group?: string }> = [];
    for (const entry of model.options) {
      if ("value" in entry) {
        out.push({ value: entry.value, name: entry.name, description: entry.description });
      } else if ("options" in entry && Array.isArray(entry.options)) {
        for (const inner of entry.options) {
          out.push({
            value: inner.value,
            name: inner.name,
            description: inner.description,
            group: entry.name,
          });
        }
      }
    }
    return out;
  }

  /** The human-readable name of the active model, when the agent exposes one. */
  modelName(): string | undefined {
    const model = this.find("model");
    if (!model || model.currentValue === undefined) return undefined;
    return humanModelName(String(model.currentValue));
  }

  /** Every value the option accepts, flattened across ACP groups. */
  values(idOrCategory: string): string[] {
    const option = this.find(idOrCategory);
    if (!option || !Array.isArray(option.options)) return [];
    const out: string[] = [];
    for (const entry of option.options) {
      if ("value" in entry) out.push(entry.value);
      else if ("options" in entry && Array.isArray(entry.options)) {
        for (const inner of entry.options) out.push(inner.value);
      }
    }
    return out;
  }

  /**
   * Forward one choice. The value is passed through untouched — a boolean stays
   * a boolean — and the response's complete state replaces ours, so a set that
   * is not followed by `config_option_update` is not left stale.
   */
  async set(
    connection: AcpConnection,
    sessionId: string,
    id: string,
    value: ConfigOptionValue,
  ): Promise<void> {
    // `AcpConnection.setConfigOption` declares `string` because most options are
    // selects; ACP boolean options must still be forwarded as booleans. The cast
    // is type-only — the runtime value is unchanged.
    const result = await connection.setConfigOption(
      sessionId,
      id,
      value as unknown as string,
    );
    if (Array.isArray(result)) this.options = result as AcpConfigOption[];
  }
}

function toSnapshot(option: AcpConfigOption): ConfigOptionSnapshot {
  const value: ConfigOptionValue =
    typeof option.currentValue === "boolean"
      ? option.currentValue
      : String(option.currentValue ?? "");
  const entries = Array.isArray(option.options) ? option.options : [];
  const choices = entries
    .map((entry): ConfigOptionChoice | ConfigOptionGroup => {
      if ("value" in entry) {
        return {
          value: entry.value,
          ...(entry.name !== undefined ? { name: entry.name } : {}),
          ...(entry.description !== undefined ? { description: entry.description } : {}),
        };
      }
      return {
        group: entry.group,
        ...(entry.name !== undefined ? { name: entry.name } : {}),
        options: Array.isArray(entry.options)
          ? entry.options.map((inner) => ({
              value: inner.value,
              ...(inner.name !== undefined ? { name: inner.name } : {}),
              ...(inner.description !== undefined ? { description: inner.description } : {}),
            }))
          : [],
      };
    })
    .filter((entry) => ("value" in entry ? entry.value.length > 0 : true));

  const description = (option as { description?: unknown }).description;
  return {
    id: option.id,
    name: option.name ?? option.id,
    ...(typeof description === "string" ? { description } : {}),
    ...(typeof option.category === "string" ? { category: option.category } : {}),
    ...(typeof option.type === "string" ? { type: option.type } : {}),
    currentValue: value,
    ...(choices.length > 0 ? { options: choices } : {}),
  };
}

/** ACP's model value can be a JSON `[provider, model]` pair, or plain text. */
export function humanModelName(value: string): string {
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.length === 2) return `${parsed[0]}/${parsed[1]}`;
  } catch {
    // not JSON; fall through
  }
  return value;
}

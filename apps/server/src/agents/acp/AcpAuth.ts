import type { AuthMethodInfo, AuthSnapshot } from "@absence/core";
import { AcpRpcError, type AcpInitializeResult } from "./AcpConnection";

/**
 * The authentication state the agent advertised.
 *
 * ACP lets an agent answer `initialize` with login methods and then refuse
 * `session/new` until `authenticate` succeeds. This module keeps that small
 * state (methods + whether a session is blocked) and recognises the refusal;
 * it does not choose a method, store credentials or log anyone in.
 */
export class AcpAuth {
  private methods: AuthMethodInfo[] = [];
  private required = false;
  /** Where the deferred session should be created once login succeeds. */
  private blocked?: { cwd: string; resumeHandle?: string };

  applyInitialize(result: AcpInitializeResult): void {
    this.methods = normalizeAuthMethods(result.authMethods);
  }

  snapshot(): AuthSnapshot {
    return { required: this.required, methods: [...this.methods] };
  }

  getMethods(): AuthMethodInfo[] {
    return this.methods;
  }

  get isRequired(): boolean {
    return this.required;
  }

  find(methodId: string): AuthMethodInfo | undefined {
    return this.methods.find((method) => method.id === methodId);
  }

  /** The agent blocked session creation until a method is used. */
  markBlocked(pending: { cwd: string; resumeHandle?: string }): void {
    this.required = true;
    this.blocked = { ...pending };
  }

  /** Take the deferred session context (once), leaving `required` untouched. */
  takePending(): { cwd: string; resumeHandle?: string } | undefined {
    const pending = this.blocked;
    this.blocked = undefined;
    return pending;
  }

  clearRequired(): void {
    this.required = false;
    this.blocked = undefined;
  }
}

/**
 * ACP's `auth_required` refusal is not typed consistently across agents: some
 * send a message, some put the methods in `data.authMethods`. Accept both, but
 * do not treat an unrelated `-32000` as authentication.
 */
export function isAuthRequiredError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/auth[_ ]?required|authentication required|not authenticated|login required/i.test(message)) {
    return true;
  }
  if (error instanceof AcpRpcError && error.data && typeof error.data === "object") {
    const record = error.data as Record<string, unknown>;
    return Array.isArray(record.authMethods);
  }
  return false;
}

export function normalizeAuthMethods(value: unknown): AuthMethodInfo[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : "";
    if (!id) return [];
    return [
      {
        id,
        name: typeof record.name === "string" ? record.name : id,
        ...(typeof record.description === "string"
          ? { description: record.description }
          : {}),
      },
    ];
  });
}

export interface NativeFunctionRef {
  readonly name: string;
  readonly id: string;
}

export interface NativeContinuation {
  readonly model: string;
  readonly name: string;
  readonly callId: string;
  readonly responseId: string;
  readonly accountId: string | undefined;
  readonly expiresAt: number;
}

function modelKey(model: string): string {
  return model.replace(/^models\//u, "").toLowerCase();
}

function entryKey(model: string, callId: string): string {
  return `${modelKey(model)}\u0000${callId}`;
}

/** 短期保存 AI Studio 私有续接 ID；不落盘，也不跨账号复用。 */
export class NativeContinuationStore {
  private readonly entries = new Map<string, NativeContinuation>();

  constructor(
    private readonly ttlMs = 10 * 60 * 1000,
    private readonly maxEntries = 1024,
  ) {}

  remember(
    model: string,
    calls: readonly NativeFunctionRef[],
    responseId: string,
    accountId?: string,
  ): void {
    if (!responseId || calls.length === 0) return;
    const now = Date.now();
    this.purge(now);
    for (const call of calls) {
      if (!call.name || !call.id) continue;
      this.entries.set(entryKey(model, call.id), {
        model,
        name: call.name,
        callId: call.id,
        responseId,
        accountId,
        expiresAt: now + Math.max(1_000, this.ttlMs),
      });
    }
    while (this.entries.size > Math.max(1, this.maxEntries)) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  find(model: string, calls: readonly NativeFunctionRef[]): NativeContinuation | undefined {
    if (calls.length === 0) return undefined;
    this.purge();
    const matches = calls.map(call => this.entries.get(entryKey(model, call.id)));
    if (matches.some((entry): entry is undefined => !entry)) return undefined;
    const first = matches[0];
    if (!first) return undefined;
    for (let index = 0; index < matches.length; index += 1) {
      const entry = matches[index];
      const call = calls[index];
      if (!entry || !call || entry.name !== call.name || entry.responseId !== first.responseId || entry.accountId !== first.accountId) {
        return undefined;
      }
    }
    return first;
  }

  consume(model: string, calls: readonly NativeFunctionRef[]): void {
    for (const call of calls) this.entries.delete(entryKey(model, call.id));
  }

  removeAccount(accountId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.accountId === accountId) this.entries.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    this.purge();
    return this.entries.size;
  }

  private purge(now = Date.now()): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}

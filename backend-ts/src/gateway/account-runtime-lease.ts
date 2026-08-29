import { randomUUID } from "node:crypto";
import { open, readFile, unlink } from "node:fs/promises";

interface LeaseRecord {
  readonly pid: number;
  readonly token: string;
  readonly startedAt: string;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readLease(path: string): Promise<LeaseRecord | undefined> {
  try {
    const value = JSON.parse(
      await readFile(path, "utf8"),
    ) as Partial<LeaseRecord>;
    if (
      typeof value.pid !== "number" ||
      typeof value.token !== "string" ||
      typeof value.startedAt !== "string"
    )
      return undefined;
    return value as LeaseRecord;
  } catch {
    return undefined;
  }
}

export class AccountRuntimeLease {
  private released = false;

  private constructor(
    private readonly path: string,
    private readonly record: LeaseRecord,
  ) {}

  static async acquire(path: string): Promise<AccountRuntimeLease> {
    const record: LeaseRecord = {
      pid: process.pid,
      token: randomUUID(),
      startedAt: new Date().toISOString(),
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(path, "wx");
        try {
          await handle.writeFile(JSON.stringify(record, null, 2), "utf8");
        } finally {
          await handle.close();
        }
        return new AccountRuntimeLease(path, record);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await readLease(path);
        if (existing && processIsAlive(existing.pid)) {
          throw new Error(
            `Account browser profile is already leased by PID ${existing.pid} since ${existing.startedAt}`,
          );
        }
        await unlink(path).catch((unlinkError) => {
          if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT")
            throw unlinkError;
        });
      }
    }
    throw new Error("Failed to acquire account browser profile lease");
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    const existing = await readLease(this.path);
    if (existing?.token === this.record.token)
      await unlink(this.path).catch(() => undefined);
  }
}

import { appendFile, mkdir, readFile, writeFile } from "fs/promises";
import path from "path";
import type { AuditEvent } from "@/lib/types";

export type { AuditEvent };

type AuditRow = AuditEvent & { detail?: unknown };

const DIR = path.join(process.cwd(), ".audit");
const FILE = path.join(DIR, "reap.jsonl");

function redact(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === "string") {
    if (value.startsWith("sk_") || value.startsWith("Bearer ")) return "[redacted]";
    if (/session=/.test(value)) {
      try {
        const u = new URL(value);
        return `${u.origin}${u.pathname}`;
      } catch {
        return value.split("?")[0];
      }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const key = k.toLowerCase();
      if (["authorization", "apikey", "api_key", "card", "cvv", "pan", "number"].includes(key)) {
        out[k] = "[redacted]";
      } else {
        out[k] = redact(v);
      }
    }
    return out;
  }
  return value;
}

export async function audit(event: Omit<AuditRow, "ts"> & { ts?: string }): Promise<AuditEvent> {
  const row: AuditRow = {
    ...event,
    ts: event.ts ?? new Date().toISOString(),
    detail: event.detail === undefined ? undefined : redact(event.detail),
  };
  await mkdir(DIR, { recursive: true });
  await appendFile(FILE, `${JSON.stringify(row)}\n`, "utf8");
  console.info("[audit]", row.kind, row.message, {
    enrollmentId: row.enrollmentId,
    enrollmentStatus: row.enrollmentStatus,
    httpStatus: row.httpStatus,
  });
  return row;
}

export async function readAudit(limit = 80): Promise<AuditEvent[]> {
  try {
    const raw = await readFile(FILE, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    return lines.slice(-limit).map((line) => JSON.parse(line) as AuditRow);
  } catch {
    return [];
  }
}

export async function clearAudit(): Promise<void> {
  await mkdir(DIR, { recursive: true });
  await writeFile(FILE, "", "utf8");
}

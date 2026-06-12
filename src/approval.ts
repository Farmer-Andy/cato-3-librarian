import { generateULID } from './ulid';

const TTL_MS = 60 * 60 * 1000; // 1 hour

export interface PendingApproval {
  id: string;
  created_at: string;
  expires_at: string;
  requested_by: string;
  operation_kind: string;
  sql_text: string;
  rationale: string | null;
  status: string;
}

export function enqueueApproval(
  sql: SqlStorage,
  params: { requestedBy: string; operationKind: 'ddl' | 'destructive_write'; sqlText: string; rationale: string }
): string {
  const id = generateULID();
  const expiresAt = new Date(Date.now() + TTL_MS).toISOString();
  sql.exec(
    `INSERT INTO approval_pending (id, expires_at, requested_by, operation_kind, sql_text, rationale)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id, expiresAt, params.requestedBy, params.operationKind, params.sqlText, params.rationale
  );
  return id;
}

export function processApproval(
  sql: SqlStorage,
  id: string,
  action: 'granted' | 'denied',
  adminActor: string,
  onGrant: (sqlText: string) => void
): { ok: boolean; message: string } {
  const rows = sql.exec(
    `SELECT * FROM approval_pending WHERE id = ?`, id
  ).toArray() as Array<Record<string, unknown>>;

  if (rows.length === 0) {
    return { ok: false, message: `No pending approval found with ID ${id}` };
  }

  const row = rows[0];
  if (row['status'] !== 'pending') {
    return { ok: false, message: `Approval ${id} is already ${row['status']}` };
  }

  const now = new Date().toISOString();
  if (row['expires_at'] as string < now) {
    sql.exec(`UPDATE approval_pending SET status = 'expired' WHERE id = ?`, id);
    return { ok: false, message: `Approval ${id} has expired` };
  }

  // Flip to a transitional status to prevent TTL race
  sql.exec(`UPDATE approval_pending SET status = 'executing' WHERE id = ?`, id);

  if (action === 'granted') {
    try {
      onGrant(row['sql_text'] as string);
      sql.exec(`UPDATE approval_pending SET status = 'granted' WHERE id = ?`, id);
      return { ok: true, message: `Approval ${id} granted and executed by ${adminActor}` };
    } catch (err) {
      sql.exec(`UPDATE approval_pending SET status = 'pending' WHERE id = ?`, id);
      return { ok: false, message: `Execution failed: ${String(err)}` };
    }
  } else {
    sql.exec(`UPDATE approval_pending SET status = 'denied' WHERE id = ?`, id);
    return { ok: true, message: `Approval ${id} denied by ${adminActor}` };
  }
}

export function sweepExpired(sql: SqlStorage): number {
  const now = new Date().toISOString();
  sql.exec(
    `UPDATE approval_pending SET status = 'expired' WHERE status = 'pending' AND expires_at < ?`, now
  );
  const rows = sql.exec(`SELECT changes() as n`).toArray();
  return rows.length > 0 ? Number((rows[0] as Record<string, unknown>)['n']) : 0;
}

export function listPendingApprovals(sql: SqlStorage): PendingApproval[] {
  return sql.exec(
    `SELECT * FROM approval_pending WHERE status = 'pending' ORDER BY created_at ASC`
  ).toArray() as unknown as PendingApproval[];
}

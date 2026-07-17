import type { SQLClass } from './types';
import type { ToolDefinition } from './llm';

// --- SQL classifier ---

const DDL_KEYWORDS = new Set(['CREATE', 'ALTER', 'DROP', 'REINDEX', 'VACUUM']);
const WRITE_KEYWORDS = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'UPSERT']);
const READ_KEYWORDS = new Set(['SELECT', 'WITH', 'PRAGMA', 'EXPLAIN', 'VALUES']);

export function classifySQL(sql: string): SQLClass {
  const stripped = stripCommentsAndStrings(sql);
  const firstKeyword = extractFirstKeyword(stripped);
  if (!firstKeyword) return 'unknown';
  if (DDL_KEYWORDS.has(firstKeyword)) return 'ddl';
  if (WRITE_KEYWORDS.has(firstKeyword)) return 'write';
  // A WITH clause can prefix INSERT/UPDATE/DELETE as well as SELECT — classifying
  // it as read by first keyword alone let CTE-wrapped mutations through the
  // read-only query tool. Classify by the top-level statement verb instead.
  if (firstKeyword === 'WITH') return classifyCTE(stripped);
  // Assignment-form pragmas (PRAGMA writable_schema = ON, PRAGMA user_version = 7)
  // mutate state; only the bare/function forms are reads.
  if (firstKeyword === 'PRAGMA') return isPragmaAssignment(stripped) ? 'unknown' : 'read';
  if (READ_KEYWORDS.has(firstKeyword)) return 'read';
  return 'unknown';
}

// Find the first paren-depth-0 statement verb after the CTE definitions.
// CTE bodies live inside parentheses, so the first top-level write/select
// keyword is the statement the CTE feeds.
function classifyCTE(stripped: string): SQLClass {
  let depth = 0;
  let sawWith = false;
  const re = /[()]|[A-Za-z_]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const tok = m[0];
    if (tok === '(') { depth += 1; continue; }
    if (tok === ')') { depth -= 1; continue; }
    if (depth !== 0) continue;
    const kw = tok.toUpperCase();
    if (!sawWith) {
      if (kw === 'WITH') sawWith = true;
      continue;
    }
    if (WRITE_KEYWORDS.has(kw)) return 'write';
    if (kw === 'SELECT' || kw === 'VALUES') return 'read';
  }
  return 'unknown';
}

function isPragmaAssignment(stripped: string): boolean {
  return /^\s*PRAGMA\s+[A-Za-z_.]+\s*=/i.test(stripped);
}

export function isUnsafeWrite(sql: string): boolean {
  const stripped = stripCommentsAndStrings(sql).toUpperCase();
  const firstKeyword = extractFirstKeyword(stripped);
  if (firstKeyword !== 'DELETE' && firstKeyword !== 'UPDATE') return false;
  // Token check, not substring: identifiers like SOMEWHERE must not satisfy the guard.
  // Known residual gap (shared with phase-2): a tautological clause like
  // WHERE id = id still counts as constrained. Structural analysis is out of scope.
  return !/\bWHERE\b/.test(stripped);
}

// --- Protected tables ---

// The agent's own infrastructure tables. LLM-issued SQL must not mutate these:
// the audit trail is only trustworthy, and the approval queue only meaningful,
// if the model cannot rewrite them through the write tool. The agent's own code
// paths (logEvent, processApproval, model switching, eval recording) write them
// directly and are unaffected. Schema changes to them still go through
// propose_ddl -> admin approval, which is the intended escape hatch.
export const PROTECTED_TABLES = new Set([
  'event_log',
  'approval_pending',
  'model_registry',
  'active_model',
  'eval_tasks',
  'eval_runs',
  'mutations',
  'skill_versions',
  '_meta_comments',
]);

// Mutation targets of a statement: every identifier following INSERT/REPLACE
// INTO, UPDATE, or DELETE FROM anywhere in the statement, so CTE-wrapped and
// multi-clause forms are covered. Deliberately over-matches — this feeds a
// denylist, where a false positive is a safe rejection and a false negative is
// the failure mode. Handles "quoted", [bracketed], `backticked`, and
// schema.qualified identifiers.
export function findMutationTargets(sql: string): string[] {
  const stripped = stripCommentsAndStrings(sql);
  const targets: string[] = [];
  const re = /\b(?:INSERT\s+(?:OR\s+[A-Za-z]+\s+)?INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+[A-Za-z]+)?|DELETE\s+FROM)\s+([A-Za-z_"[\]`][\w".[\]`]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const unquoted = m[1].replace(/["[\]`]/g, '');
    const name = unquoted.slice(unquoted.lastIndexOf('.') + 1);
    targets.push(name.toLowerCase());
  }
  return targets;
}

function extractFirstKeyword(sql: string): string {
  const match = sql.trim().match(/^([A-Z_]+)/i);
  return match ? match[1].toUpperCase() : '';
}

function stripCommentsAndStrings(sql: string): string {
  let result = '';
  let i = 0;
  while (i < sql.length) {
    // Single-line comment
    if (sql[i] === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      result += ' ';
      continue;
    }
    // Multi-line comment
    if (sql[i] === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      result += ' ';
      continue;
    }
    // String literals (single quote)
    if (sql[i] === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i++; break; }
        i++;
      }
      result += "''";
      continue;
    }
    // Double-quoted identifiers — preserve them (they're not strings)
    result += sql[i++];
  }
  return result;
}

// --- Tool definitions for the LLM ---

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'query',
      description: 'Execute a read-only SQL statement (SELECT, PRAGMA, EXPLAIN). Rejects writes and DDL.',
      parameters: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'The SQL query to execute. Must be a read-only statement.' },
        },
        required: ['sql'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write',
      description: 'Execute a write SQL statement (INSERT, UPDATE, DELETE with WHERE). Rejects DDL and unsafe deletes without WHERE.',
      parameters: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'The write SQL to execute.' },
          rationale: { type: 'string', description: 'Reason for this write operation.' },
        },
        required: ['sql', 'rationale'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_ddl',
      description: 'Propose a DDL operation (CREATE, ALTER, DROP, etc.) for admin approval. You cannot execute DDL directly — it must be approved.',
      parameters: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'The DDL SQL to propose.' },
          rationale: { type: 'string', description: 'Why this DDL change is needed.' },
        },
        required: ['sql', 'rationale'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_pending_approvals',
      description: 'List all pending DDL approval requests.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'describe_schema',
      description: 'Get schema details from the manifest. Optionally filter to a specific table.',
      parameters: {
        type: 'object',
        properties: {
          table: { type: 'string', description: 'Optional table name to filter the manifest output.' },
        },
        required: [],
      },
    },
  },
];

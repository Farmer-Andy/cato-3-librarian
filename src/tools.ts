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
  if (READ_KEYWORDS.has(firstKeyword)) return 'read';
  return 'unknown';
}

export function isUnsafeWrite(sql: string): boolean {
  const stripped = stripCommentsAndStrings(sql).toUpperCase();
  const firstKeyword = extractFirstKeyword(stripped);
  if (firstKeyword !== 'DELETE' && firstKeyword !== 'UPDATE') return false;
  // Check for presence of WHERE clause
  return !stripped.includes('WHERE');
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

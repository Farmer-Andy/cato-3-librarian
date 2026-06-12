export interface Env {
  CATO_AGENT: DurableObjectNamespace;
  OPENROUTER_API_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
  ADMIN_TELEGRAM_ID: string;
}

export interface Actor {
  id: string;
  role: 'admin' | 'user' | 'system';
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface LLMResponse {
  content: string | null;
  tool_calls?: ToolCall[];
  model: string;
}

export type SQLClass = 'read' | 'write' | 'ddl' | 'unknown';

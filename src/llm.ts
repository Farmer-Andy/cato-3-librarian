import type { LLMMessage, LLMResponse, ToolCall } from './types';

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export async function callLLM(input: {
  apiKey: string;
  primaryModel: string;
  fallbackModel: string | null;
  messages: LLMMessage[];
  tools: ToolDefinition[];
}): Promise<LLMResponse> {
  const models = [input.primaryModel, ...(input.fallbackModel ? [input.fallbackModel] : [])];
  let lastError = 'No model attempted';

  for (const model of models) {
    const controller = new AbortController();
    // 60s: reasoning-tier default models (e.g. xiaomi/mimo-v2.5-pro) run long on tool turns; was 25s.
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/Farmer-Andy/cato-3-librarian',
          'X-Title': 'Cato-3 Librarian',
        },
        body: JSON.stringify({
          model,
          messages: input.messages,
          tools: input.tools.length > 0 ? input.tools : undefined,
          tool_choice: input.tools.length > 0 ? 'auto' : undefined,
          temperature: 0.4,
          max_tokens: 8000,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        lastError = `Model ${model} returned ${res.status}`;
        continue;
      }

      const data = (await res.json()) as {
        choices?: Array<{
          message?: {
            content?: string | null;
            tool_calls?: ToolCall[];
          };
        }>;
      };

      const message = data.choices?.[0]?.message;
      if (!message) {
        lastError = `Model ${model} returned no message`;
        continue;
      }

      return {
        content: message.content ?? null,
        tool_calls: message.tool_calls,
        model,
      };
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        lastError = `Model ${model} timed out`;
      } else {
        lastError = `Model ${model} threw: ${String(err)}`;
      }
    } finally {
      // Always clear the abort timer. A fetch that throws (or a non-ok/continue
      // path) would otherwise leave it pending to fire later and abort an
      // unrelated request on this isolate.
      clearTimeout(timeoutId);
    }
  }

  throw new Error(lastError);
}

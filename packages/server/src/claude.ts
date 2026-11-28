import Anthropic from "@anthropic-ai/sdk";
import { ClaudeReasoner, type ClaudeClient } from "@karatos/core";

/**
 * The Claude reasoner for an instance, over the Anthropic SDK. It is off by
 * default: it runs only when CLAUDE_REASONER is on and ANTHROPIC_API_KEY is
 * set. The request carries the reasoner's summary and fixed instructions
 * only, asks for JSON in the findings schema and gives the model no tools.
 * See docs/claude-reasoner.md.
 */

/** Opts into the server-side fallback, so a request the model declines can be answered by the API's default fallback model. */
export const CLAUDE_FALLBACK_BETA = "server-side-fallback-2026-07-01";

export interface AnthropicClientOptions {
  apiKey: string;
  /** For tests: a fetch that answers in place of the API. */
  fetch?: typeof fetch;
  /** Retries the SDK makes on a rate limit, an overload or a dropped connection. Default 1, so a run stays inside its time-out. */
  maxRetries?: number;
}

/** A ClaudeClient that sends one Messages API request per run. */
export function anthropicClaudeClient(options: AnthropicClientOptions): ClaudeClient {
  const client = new Anthropic({ apiKey: options.apiKey, maxRetries: options.maxRetries ?? 1, ...(options.fetch ? { fetch: options.fetch } : {}) });
  return async (request, { signal }) => {
    const response = await client.beta.messages.create(
      {
        model: request.model,
        max_tokens: request.maxOutputTokens,
        betas: [CLAUDE_FALLBACK_BETA],
        fallbacks: "default",
        // The instructions are the same on every run, so they are marked for caching.
        system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: request.user }],
        output_config: { effort: "medium", format: { type: "json_schema", schema: request.schema } },
      },
      { signal, timeout: request.timeoutMs },
    );
    const text = response.content.map((block) => (block.type === "text" ? block.text : "")).join("");
    return {
      text,
      stopReason: response.stop_reason,
      model: response.model,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? 0,
      },
    };
  };
}

export interface InstanceClaudeSettings {
  CLAUDE_REASONER: boolean;
  CLAUDE_REASONER_MAX_TOKENS: number;
  CLAUDE_REASONER_TIMEOUT_SECONDS: number;
}

/**
 * The instance's Claude reasoner, or null with why it is off. The key is
 * read from env and never logged or returned.
 */
export function instanceClaudeReasoner(
  config: InstanceClaudeSettings,
  env: Record<string, string | undefined>,
  options: { makeClient?: (apiKey: string) => ClaudeClient; log?: (line: string) => void } = {},
): { reasoner: ClaudeReasoner | null; status: string } {
  if (!config.CLAUDE_REASONER) return { reasoner: null, status: "claude reasoner off (CLAUDE_REASONER is not on)" };
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return { reasoner: null, status: "claude reasoner off: CLAUDE_REASONER is on but ANTHROPIC_API_KEY is not set" };
  const client = (options.makeClient ?? ((key: string) => anthropicClaudeClient({ apiKey: key })))(apiKey);
  const reasoner = new ClaudeReasoner({
    client,
    tokenCap: config.CLAUDE_REASONER_MAX_TOKENS,
    timeoutMs: config.CLAUDE_REASONER_TIMEOUT_SECONDS * 1000,
    ...(options.log ? { log: options.log } : {}),
  });
  return { reasoner, status: `claude reasoner on: up to ${config.CLAUDE_REASONER_MAX_TOKENS} tokens a run, ${config.CLAUDE_REASONER_TIMEOUT_SECONDS}s time-out` };
}

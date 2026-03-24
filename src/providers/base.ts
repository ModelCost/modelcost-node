/**
 * Usage information extracted from a provider's API response.
 */
export interface ExtractedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
}

/**
 * Base interface that all provider wrappers must implement.
 */
export interface BaseProvider {
  /**
   * Wrap an AI client with cost tracking, budget enforcement, and PII scanning.
   * Returns a proxied version of the client.
   */
  wrap(client: unknown): unknown;

  /**
   * Extract token usage from a provider-specific API response.
   */
  extractUsage(response: unknown): ExtractedUsage;

  /**
   * Get the canonical provider name.
   */
  getProviderName(): string;
}

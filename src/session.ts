import {
  SessionBudgetExceededError,
  SessionIterationLimitExceededError,
} from "./errors.js";

/**
 * A single recorded call within a session.
 */
export interface SessionCallRecord {
  callSequence: number;
  callType: string;
  toolName?: string;
  inputTokens: number;
  outputTokens: number;
  cumulativeInputTokens: number;
  costUsd: number;
  cumulativeCostUsd: number;
  createdAt: Date;
}

/**
 * Options for creating a new SessionContext.
 */
export interface SessionOptions {
  sessionId: string;
  serverSessionId?: string;
  feature?: string;
  userId?: string;
  maxSpendUsd?: number;
  maxIterations?: number;
}

/**
 * Local session governance context.
 *
 * Tracks cumulative spend, iteration count, and call history for an
 * agent session. Enforces budget and iteration limits before each call
 * via `preCallCheck()`.
 */
export class SessionContext {
  readonly sessionId: string;
  serverSessionId?: string;
  readonly feature?: string;
  readonly userId?: string;
  readonly maxSpendUsd?: number;
  readonly maxIterations?: number;

  private _currentSpendUsd = 0;
  private _iterationCount = 0;
  private _cumulativeInputTokens = 0;
  private _status: "active" | "completed" | "terminated" = "active";
  private _terminationReason?: string;
  private _calls: SessionCallRecord[] = [];

  constructor(options: SessionOptions) {
    this.sessionId = options.sessionId;
    this.serverSessionId = options.serverSessionId;
    this.feature = options.feature;
    this.userId = options.userId;
    this.maxSpendUsd = options.maxSpendUsd;
    this.maxIterations = options.maxIterations;
  }

  // ─── Read-only accessors ──────────────────────────────────────────

  get currentSpendUsd(): number {
    return this._currentSpendUsd;
  }

  get iterationCount(): number {
    return this._iterationCount;
  }

  get status(): string {
    return this._status;
  }

  get terminationReason(): string | undefined {
    return this._terminationReason;
  }

  get calls(): readonly SessionCallRecord[] {
    return this._calls;
  }

  get remainingBudget(): number | undefined {
    if (this.maxSpendUsd === undefined) return undefined;
    return Math.max(0, this.maxSpendUsd - this._currentSpendUsd);
  }

  get remainingIterations(): number | undefined {
    if (this.maxIterations === undefined) return undefined;
    return Math.max(0, this.maxIterations - this._iterationCount);
  }

  // ─── Lifecycle methods ────────────────────────────────────────────

  /**
   * Pre-flight check before making an AI call.
   * Throws if budget or iteration limits would be exceeded.
   */
  preCallCheck(estimatedCost: number): void {
    if (this.maxSpendUsd !== undefined) {
      if (this._currentSpendUsd + estimatedCost > this.maxSpendUsd) {
        this._status = "terminated";
        this._terminationReason = "budget_exceeded";
        throw new SessionBudgetExceededError(
          `Session budget exceeded: current spend $${this._currentSpendUsd.toFixed(4)} + estimated $${estimatedCost.toFixed(4)} > limit $${this.maxSpendUsd.toFixed(4)}`,
          this.sessionId,
          this._currentSpendUsd,
          this.maxSpendUsd,
        );
      }
    }

    if (this.maxIterations !== undefined) {
      if (this._iterationCount + 1 > this.maxIterations) {
        this._status = "terminated";
        this._terminationReason = "iteration_limit_exceeded";
        throw new SessionIterationLimitExceededError(
          `Session iteration limit exceeded: ${this._iterationCount + 1} > ${this.maxIterations}`,
          this.sessionId,
          this._iterationCount,
          this.maxIterations,
        );
      }
    }
  }

  /**
   * Record a completed call, updating cumulative counters.
   */
  recordCall(options: {
    callType: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    toolName?: string;
  }): SessionCallRecord {
    this._iterationCount++;
    this._currentSpendUsd += options.costUsd;
    this._cumulativeInputTokens += options.inputTokens;

    const record: SessionCallRecord = {
      callSequence: this._iterationCount,
      callType: options.callType,
      toolName: options.toolName,
      inputTokens: options.inputTokens,
      outputTokens: options.outputTokens,
      cumulativeInputTokens: this._cumulativeInputTokens,
      costUsd: options.costUsd,
      cumulativeCostUsd: this._currentSpendUsd,
      createdAt: new Date(),
    };

    this._calls.push(record);
    return record;
  }

  /**
   * Close the session with a terminal status.
   */
  close(reason = "completed"): void {
    this._status = reason === "completed" ? "completed" : "terminated";
    this._terminationReason = reason;
  }
}

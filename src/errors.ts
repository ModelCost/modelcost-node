import type { DetectedViolation } from "./models/governance.js";

/**
 * Base error class for all ModelCost SDK errors.
 */
export class ModelCostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelCostError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when the SDK is misconfigured (invalid API key, missing org ID, etc.).
 */
export class ConfigurationError extends ModelCostError {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

/**
 * Thrown when a request is blocked because the budget has been exceeded.
 */
export class BudgetExceededError extends ModelCostError {
  public readonly remainingBudget: number;
  public readonly scope: string;
  public readonly overrideUrl?: string;

  constructor(
    message: string,
    remainingBudget: number,
    scope: string,
    overrideUrl?: string,
  ) {
    super(message);
    this.name = "BudgetExceededError";
    this.remainingBudget = remainingBudget;
    this.scope = scope;
    this.overrideUrl = overrideUrl;
  }
}

/**
 * Thrown when the client is rate-limited by the ModelCost API.
 */
export class RateLimitedError extends ModelCostError {
  public readonly retryAfterSeconds: number;
  public readonly limitDimension: string;

  constructor(
    message: string,
    retryAfterSeconds: number,
    limitDimension: string,
  ) {
    super(message);
    this.name = "RateLimitedError";
    this.retryAfterSeconds = retryAfterSeconds;
    this.limitDimension = limitDimension;
  }
}

/**
 * Thrown when PII is detected in scanned text and the policy requires blocking.
 */
export class PiiDetectedError extends ModelCostError {
  public readonly detectedEntities: DetectedViolation[];
  public readonly redactedText: string;

  constructor(
    message: string,
    detectedEntities: DetectedViolation[],
    redactedText: string,
  ) {
    super(message);
    this.name = "PiiDetectedError";
    this.detectedEntities = detectedEntities;
    this.redactedText = redactedText;
  }
}

/**
 * Thrown when a session's spend budget has been exceeded.
 */
export class SessionBudgetExceededError extends ModelCostError {
  public readonly sessionId: string;
  public readonly currentSpend: number;
  public readonly maxSpend: number;

  constructor(
    message: string,
    sessionId: string,
    currentSpend: number,
    maxSpend: number,
  ) {
    super(message);
    this.name = "SessionBudgetExceededError";
    this.sessionId = sessionId;
    this.currentSpend = currentSpend;
    this.maxSpend = maxSpend;
  }
}

/**
 * Thrown when a session's iteration limit has been exceeded.
 */
export class SessionIterationLimitExceededError extends ModelCostError {
  public readonly sessionId: string;
  public readonly currentIterations: number;
  public readonly maxIterations: number;

  constructor(
    message: string,
    sessionId: string,
    currentIterations: number,
    maxIterations: number,
  ) {
    super(message);
    this.name = "SessionIterationLimitExceededError";
    this.sessionId = sessionId;
    this.currentIterations = currentIterations;
    this.maxIterations = maxIterations;
  }
}

/**
 * Thrown when the ModelCost API returns an error response.
 */
export class ModelCostApiError extends ModelCostError {
  public readonly statusCode: number;
  public readonly errorCode: string;

  constructor(message: string, statusCode: number, errorCode: string) {
    super(message);
    this.name = "ModelCostApiError";
    this.statusCode = statusCode;
    this.errorCode = errorCode;
  }
}

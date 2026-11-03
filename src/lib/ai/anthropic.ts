import Anthropic from "@anthropic-ai/sdk";

// Check current model IDs in Anthropic's docs before changing these.
export const MODELS = {
  stitch: "claude-opus-5-5",
  takes: "claude-sonnet-5-5",
  ask: "claude-sonnet-5-5",
  explain: "claude-haiku-5-5",
  coach: "claude-haiku-5-5",
} as const;

/** Server-side refusal fallback (Opus 5.5 / Sonnet 5.5 only): re-runs a declined request on a recommended model. */
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

let client: Anthropic | null = null;
export function anthropic(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) throw new AiUnavailable("Claude isn’t configured on this server.");
  client ??= new Anthropic();
  return client;
}

export class AiUnavailable extends Error {}

/** Map SDK errors to the prototype's user-facing copy. */
export function aiErrorMessage(e: unknown): string {
  if (e instanceof AiUnavailable) return e.message;
  if (e instanceof Anthropic.RateLimitError) return "Claude is busy or you’ve reached a usage limit. Try again in a little while.";
  if (e instanceof Anthropic.BadRequestError) return /too long|too large|context/i.test(e.message) ? "The draft is too long to send in one go." : "Claude couldn’t process that request.";
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return "Claude isn’t available for this account.";
  if (e instanceof Anthropic.APIUserAbortError) return "Stopped.";
  if (e instanceof Anthropic.InternalServerError) return "Claude had a problem. Try again.";
  if (e instanceof Anthropic.APIConnectionError) return "Connection problem. Try again.";
  return "Connection problem. Try again.";
}

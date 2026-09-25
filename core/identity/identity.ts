/**
 * Learner identity across channels — AGENT.md §6.6.
 *
 * The anchor is an opaque server-generated `learner_id`. A channel identity is a
 * linked credential that maps to exactly one learner; linking is explicit and
 * two channel identities are never guessed to be the same person (§6.6).
 *
 * This file is deliberately channel-agnostic: it treats the channel name as an
 * opaque label. Channel-specific validation (a platform's own id format) belongs
 * to the frontend adapter that knows that platform (§3).
 */
import type { ChannelKind } from "../ports/storage.js";

export class ChannelIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelIdentityError";
  }
}

/**
 * Store the channel's own numeric/opaque id, never a username or display name —
 * those change (§6.6).
 */
export function normalizeChannelUserId(channel: ChannelKind, raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new ChannelIdentityError(`${channel} identity is empty`);
  }
  return trimmed;
}

/** Stable key for the channel-link table. The domain only ever sees `learner_id`. */
export function channelLinkKey(channel: ChannelKind, channelUserId: string): string {
  return `${channel}:${normalizeChannelUserId(channel, channelUserId)}`;
}

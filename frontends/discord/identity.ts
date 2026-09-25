/**
 * Discord-specific identity rules.
 *
 * These live in the frontend, not in `core/`, because the id format is a
 * property of the channel (AGENT.md §3). The core only ever sees an opaque
 * channel id and, behind it, a server-generated `learner_id` (§6.6).
 */
import { ChannelIdentityError, normalizeChannelUserId } from "../../core/identity/identity.js";

export const DISCORD = "discord";

/**
 * A Discord user id is a snowflake. A username or display name must never be
 * stored as identity — both change (§6.6).
 */
export function discordUserIdOf(raw: string): string {
  const id = normalizeChannelUserId(DISCORD, raw);
  if (!/^\d{16,20}$/u.test(id)) {
    throw new ChannelIdentityError(
      `a Discord identity must be the numeric user id (snowflake), never a username: got "${id}"`,
    );
  }
  return id;
}

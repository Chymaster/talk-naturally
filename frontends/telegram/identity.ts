/**
 * Telegram-specific identity rules — design/72-channels.md §3.
 *
 * These live in the frontend, not in `core/`, because the id format is a
 * property of the channel (design/20-architecture.md §2). The core only ever
 * sees an opaque channel id and, behind it, a server-generated `learner_id`
 * (design/30-domain-model.md §6).
 */
import { ChannelIdentityError, normalizeChannelUserId } from "../../core/identity/identity.js";

export const TELEGRAM = "telegram";

/**
 * A Telegram user id is a positive integer. Its username and display name must
 * never be stored as identity — both change
 * (design/30-domain-model.md §6).
 */
export function telegramUserIdOf(raw: string): string {
 const id = normalizeChannelUserId(TELEGRAM, raw);
 if (!/^\d{1,16}$/u.test(id)) {
 throw new ChannelIdentityError(
 `a Telegram identity must be the numeric user id, never a username: got "${id}"`,
 );
 }
 return id;
}

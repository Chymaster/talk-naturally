/**
 * Channel access gate — design/74-access.md §3.
 *
 * Every channel adapter resolves access before it touches the engine. An unknown
 * identity becomes a pending request instead of a learner, so a scanner that
 * finds the bot cannot create learner rows or trigger a billed model call
 * (design/74-access.md §1).
 *
 * This is shared because the rule is channel-agnostic; each adapter only supplies
 * its own platform id and the display label the platform offers
 * (design/72-channels.md §1).
 */
import type { ChannelKind, StoragePort } from "../core/ports/storage.js";

/** Model-free reply while an operator has not decided yet (design/74-access.md §3). */
export const ACCESS_PENDING_REPLY =
 "Thanks for reaching out. Your access request is waiting for the operator — I can help as soon as it is approved.";

/** Model-free reply for a declined request or a revoked identity (design/74-access.md §3). */
export const ACCESS_DENIED_REPLY =
 "Your access to this tutor was not approved. If you think that is a mistake, please contact the operator.";

export type ChannelAccess =
 | { readonly kind: "granted"; readonly learnerId: string }
 | { readonly kind: "pending" }
 | { readonly kind: "denied" };

/**
 * Resolve whether a channel identity may use the engine.
 *
 * An already-linked learner is granted without consulting the access table, so
 * the link is the authority on every message. A record that is approved but
 * somehow unlinked is repaired here rather than locking the learner out. A first
 * contact creates the `pending` request and nothing else
 * (design/74-access.md §2–§3).
 */
export async function resolveChannelAccess(
 storage: StoragePort,
 channel: ChannelKind,
 channelUserId: string,
 displayName: string | null,
): Promise<ChannelAccess> {
 const linked = await storage.findLearnerId(channel, channelUserId);
 if (linked !== null) {
 return { kind: "granted", learnerId: linked };
 }

 const request = await storage.getAccessRequest(channel, channelUserId);
 if (request !== null && request.status === "approved" && request.learnerId !== null) {
 await storage.linkChannel(channel, channelUserId, request.learnerId);
 return { kind: "granted", learnerId: request.learnerId };
 }
 if (request !== null && request.status === "denied") {
 return { kind: "denied" };
 }
 if (request === null) {
 await storage.requestAccess(channel, channelUserId, displayName);
 }
 return { kind: "pending" };
}

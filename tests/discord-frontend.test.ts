/**
 * The Discord adapter, exercised without Discord.
 *
 * The frontend accepts an injectable client for exactly this reason: the whole
 * translation layer — first contact, identity resolution, turn dispatch, DM
 * delivery, slash commands — is tested with no network and no bot token.
 *
 * What this does NOT cover: `start()`, which registers slash commands over REST
 * against the real API. That stays unverified until it runs against a real
 * application (MVP.md §8.2).
 */
import { Events, type Client } from "discord.js";
import { describe, expect, it } from "vitest";
import { createScriptedModel } from "../adapters/fake-model.js";
import { MemoryStorage } from "../adapters/memory-storage.js";
import { StaticModelResolver } from "../adapters/model-resolver.js";
import { SequentialIdPort } from "../adapters/random-ids.js";
import { FixedClock } from "../adapters/system-clock.js";
import { ChannelIdentityError } from "../core/identity/identity.js";
import { createEngine } from "../engine/index.js";
import { createDiscordFrontend, type ModelAdmin } from "../frontends/discord/bot.js";
import { discordUserIdOf } from "../frontends/discord/identity.js";
import { importClass } from "../hosts/class-import.js";
import { NOW, rawFixture } from "./fixtures.js";

const USER_ID = "123456789012345678";

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const DRIFT = { branch: "drift", reply: "ok", corrections: [], signals: [] };

class FakeClient {
  readonly handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  readonly sent: { userId: string; content: string }[] = [];
  fetchShouldFail = false;
  loggedIn = false;
  destroyed = false;

  readonly users = {
    fetch: async (id: string): Promise<{ send: (content: string) => Promise<void> }> => {
      if (this.fetchShouldFail) {
        throw new Error("Cannot send messages to this user");
      }
      return {
        send: async (content: string): Promise<void> => {
          this.sent.push({ userId: id, content });
        },
      };
    },
  };

  on(event: string, handler: (...args: unknown[]) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  once(event: string, handler: (...args: unknown[]) => void): this {
    return this.on(event, handler);
  }

  async login(): Promise<string> {
    this.loggedIn = true;
    return "ok";
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(...args);
    }
  }
}

interface FrontendHarnessOptions {
  readonly outputs?: readonly unknown[];
  readonly withMaterial?: boolean;
  readonly modelAdmin?: ModelAdmin;
  /** Build the frontend directly instead of through the shared harness. */
  readonly bare?: boolean;
}

async function makeFrontend(options: FrontendHarnessOptions = {}) {
  const storage = new MemoryStorage();
  const llm = createScriptedModel(options.outputs ?? []);
  const engine = createEngine({
    storage,
    models: new StaticModelResolver(llm),
    clock: new FixedClock(NOW),
    ids: new SequentialIdPort("turn"),
  });
  const client = new FakeClient();
  let provisioned = 0;

  const frontend = createDiscordFrontend({
    token: "test-token",
    applicationId: "1",
    engine,
    storage,
    client: client as unknown as Client,
    ...(options.modelAdmin === undefined ? {} : { modelAdmin: options.modelAdmin }),
    ...(options.withMaterial === false
      ? {}
      : {
          provision: async (learnerId: string) => {
            provisioned += 1;
            await importClass(storage, learnerId, rawFixture, NOW);
          },
        }),
  });

  return { storage, client, frontend, llm, provisionedCount: () => provisioned };
}

/** A learner message whose reply we can await deterministically. */
function learnerMessage(content: string) {
  const replied = deferred<string>();
  let replyCount = 0;
  const message = {
    author: { id: USER_ID, bot: false },
    content,
    channel: { sendTyping: async () => undefined },
    reply: async (text: string) => {
      replyCount += 1;
      replied.resolve(text);
      return {};
    },
  };
  return { message, replied, replyCount: () => replyCount };
}

function slashInteraction(commandName: string, options: Record<string, string | null> = {}) {
  const edits = deferred<string>();
  const replyDeferred = deferred<string>();
  const replies: string[] = [];
  return {
    edits,
    replies,
    /** Resolves on the first `reply`, so tests need not race the async handler. */
    replied: replyDeferred,
    interaction: {
      isChatInputCommand: () => true,
      isRepliable: () => true,
      commandName,
      user: { id: USER_ID },
      replied: false,
      deferred: false,
      options: { getString: (name: string) => options[name] ?? null },
      deferReply: async () => undefined,
      editReply: async (text: string) => {
        edits.resolve(text);
        return {};
      },
      reply: async (payload: { content: string }) => {
        replies.push(payload.content);
        replyDeferred.resolve(payload.content);
        return {};
      },
    },
  };
}

describe("discord identity", () => {
  it("accepts a numeric user id and rejects a username", () => {
    expect(discordUserIdOf(USER_ID)).toBe(USER_ID);
    expect(() => discordUserIdOf("some_username")).toThrow(ChannelIdentityError);
    expect(() => discordUserIdOf("   ")).toThrow(ChannelIdentityError);
  });
});

describe("discord message handling", () => {
  it("provisions on first contact, links the identity, and replies through the engine", async () => {
    const { storage, client, llm } = await makeFrontend({
      outputs: [{ branch: "drift", reply: "Fußball ist toll!", corrections: [], signals: [] }],
    });

    const { message, replied } = learnerMessage("Am Wochenende spiele ich Fußball.");
    client.emit(Events.MessageCreate, message);

    expect(await replied.promise).toBe("Fußball ist toll!");
    const learnerId = await storage.findLearnerId("discord", USER_ID);
    expect(learnerId).not.toBeNull();
    expect(await storage.listClasses(learnerId!)).toHaveLength(1);
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]?.messages.at(-1)?.content).toBe("Am Wochenende spiele ich Fußball.");
  });

  it("provisions only once across several messages", async () => {
    const { client, provisionedCount } = await makeFrontend({
      outputs: [
        { branch: "drift", reply: "one", corrections: [], signals: [] },
        { branch: "drift", reply: "two", corrections: [], signals: [] },
      ],
    });

    const first = learnerMessage("hallo");
    client.emit(Events.MessageCreate, first.message);
    await first.replied.promise;

    const second = learnerMessage("nochmal");
    client.emit(Events.MessageCreate, second.message);
    await second.replied.promise;

    expect(provisionedCount()).toBe(1);
  });

  it("ignores other bots and empty messages", async () => {
    const { storage, client, llm } = await makeFrontend({ outputs: [DRIFT] });
    const silent = { reply: async () => ({}) };

    client.emit(Events.MessageCreate, {
      author: { id: "999999999999999999", bot: true },
      content: "beep",
      channel: {},
      ...silent,
    });
    client.emit(Events.MessageCreate, {
      author: { id: USER_ID, bot: false },
      content: "   ",
      channel: {},
      ...silent,
    });

    expect(llm.requests).toHaveLength(0);
    // Nothing was linked either: these never reach the engine.
    await expect(storage.findLearnerId("discord", USER_ID)).resolves.toBeNull();
  });

  it("says so when the learner has no material yet", async () => {
    const { storage, client } = await makeFrontend({ withMaterial: false });

    const { message, replied } = learnerMessage("hallo");
    client.emit(Events.MessageCreate, message);

    expect(await replied.promise).toContain("study material");
    const learnerId = await storage.findLearnerId("discord", USER_ID);
    expect(await storage.listClasses(learnerId!)).toHaveLength(0);
  });

  it("answers with the retryable failure message when the model is unavailable", async () => {
    const { client } = await makeFrontend({ outputs: [] });

    const { message, replied } = learnerMessage("hallo");
    client.emit(Events.MessageCreate, message);

    expect(await replied.promise).toContain("Try again");
  });
});

describe("discord delivery", () => {
  it("reports failure for a learner with no linked channel identity", async () => {
    const { frontend } = await makeFrontend({});
    expect(await frontend.sendToLearner("lrn_unknown", "hello")).toBe(false);
  });

  it("DMs the linked user, and reports failure when the DM cannot be sent", async () => {
    const { storage, client, frontend } = await makeFrontend({ outputs: [DRIFT] });

    const { message, replied } = learnerMessage("hallo");
    client.emit(Events.MessageCreate, message);
    await replied.promise;
    const learnerId = await storage.findLearnerId("discord", USER_ID);

    expect(await frontend.sendToLearner(learnerId!, "session time")).toBe(true);
    expect(client.sent.at(-1)).toEqual({ userId: USER_ID, content: "session time" });

    client.fetchShouldFail = true;
    expect(await frontend.sendToLearner(learnerId!, "again")).toBe(false);
  });
});

describe("discord slash commands", () => {
  it("/start opens a session with a target-backed message", async () => {
    const { client } = await makeFrontend({ outputs: [{ reply: "Hallo! Womit fährst du?" }] });
    const { interaction, edits } = slashInteraction("start");

    client.emit(Events.InteractionCreate, interaction);
    expect(await edits.promise).toContain("Womit");
  });

  it("/model reports the effective model and applies a learner override", async () => {
    const overrides: { learnerId: string; apiKey: string; modelId?: string }[] = [];
    const modelAdmin: ModelAdmin = {
      describe: () => ({
        modelId: "deployer-model",
        baseUrl: "https://example.test/v1",
        source: "deployer",
      }),
      setLearnerOverride: (learnerId, apiKey, modelId) => {
        overrides.push({ learnerId, apiKey, ...(modelId === undefined ? {} : { modelId }) });
      },
      clearLearnerOverride: () => undefined,
    };
    const { client } = await makeFrontend({ modelAdmin });

    const show = slashInteraction("model");
    client.emit(Events.InteractionCreate, show.interaction);
    expect(await show.replied.promise).toContain("deployer-model");

    const set = slashInteraction("model", { api_key: "learner-key", model: "my-model" });
    client.emit(Events.InteractionCreate, set.interaction);
    await set.replied.promise;
    expect(overrides).toHaveLength(1);
    expect(overrides[0]?.apiKey).toBe("learner-key");
    expect(overrides[0]?.modelId).toBe("my-model");
    expect(overrides[0]?.learnerId).toMatch(/^lrn_/u);
  });

  it("/model explains itself when the deployment fixes the model", async () => {
    const { client } = await makeFrontend({ withMaterial: false });
    const { interaction, replied } = slashInteraction("model");

    client.emit(Events.InteractionCreate, interaction);
    expect(await replied.promise).toContain("fixed by the operator");
  });
});

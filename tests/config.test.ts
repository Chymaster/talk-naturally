/**
 * Model configuration resolution (MVP.md §3) and its precedence rules.
 */
import { describe, expect, it } from "vitest";
import { describeModelSettings, resolveAppConfig } from "../hosts/config.js";

describe("resolveAppConfig", () => {
  it("falls back to the built-in default with no configuration at all", () => {
    const config = resolveAppConfig({});
    expect(config.model).toMatchObject({
      baseUrl: "https://openrouter.ai/api/v1",
      modelId: "google/gemma-4-26b-a4b-it",
      source: "default",
      apiKey: null,
    });
    expect(config.model.capabilities.structuredOutput).toBe(true);
    expect(config.schedule.hourLocal).toBe(9);
    expect(config.dbPath).toBe("./var/talk-naturally.db");
  });

  it("takes deployer configuration from the environment", () => {
    const config = resolveAppConfig({
      TALK_MODEL_BASE_URL: "https://models.internal/v1",
      TALK_MODEL_ID: "local-model",
      TALK_MODEL_API_KEY: "deployer-key",
      TALK_DB_PATH: "/srv/talk.db",
      TALK_SCHEDULE_HOUR: "20",
    });
    expect(config.model).toMatchObject({
      baseUrl: "https://models.internal/v1",
      modelId: "local-model",
      source: "deployer",
      apiKey: "deployer-key",
    });
    expect(config.dbPath).toBe("/srv/talk.db");
    expect(config.schedule.hourLocal).toBe(20);
  });

  it("lets a learner-supplied key win over the deployer key", () => {
    const config = resolveAppConfig(
      { TALK_MODEL_API_KEY: "deployer-key" },
      { learnerApiKey: "learner-key" },
    );
    expect(config.model.apiKey).toBe("learner-key");
    expect(config.model.source).toBe("learner");
  });

  it("treats an unknown endpoint conservatively", () => {
    const config = resolveAppConfig({ TALK_MODEL_BASE_URL: "https://models.internal/v1" });
    expect(config.model.capabilities).toMatchObject({
      structuredOutput: false,
      toolCalls: false,
      maxContextTokens: 8192,
    });
  });

  it("honours an explicit capability declaration", () => {
    const config = resolveAppConfig({
      TALK_MODEL_CAPABILITIES: JSON.stringify({ structuredOutput: true, maxContextTokens: 4096 }),
    });
    expect(config.model.capabilities).toMatchObject({
      structuredOutput: true,
      toolCalls: false,
      maxContextTokens: 4096,
    });
  });

  it("rejects malformed capability configuration loudly", () => {
    expect(() => resolveAppConfig({ TALK_MODEL_CAPABILITIES: "not json" })).toThrow(/JSON object/u);
    expect(() => resolveAppConfig({ TALK_SCHEDULE_HOUR: "25" })).toThrow(/0-23/u);
  });

  it("allows the scheduler to be disabled", () => {
    expect(resolveAppConfig({ TALK_SCHEDULE_HOUR: "" }).schedule.hourLocal).toBeNull();
  });

  it("describes the model without ever exposing the key", () => {
    const config = resolveAppConfig({ TALK_MODEL_API_KEY: "super-secret" });
    const described = JSON.stringify(describeModelSettings(config.model));
    expect(described).not.toContain("super-secret");
    expect(described).toContain('"hasKey":true');
  });
});

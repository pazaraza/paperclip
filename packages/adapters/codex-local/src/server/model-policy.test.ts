import { describe, expect, it } from "vitest";
import { buildCodexExecArgs } from "./codex-args.js";
import {
  classifyCodexAuthJson,
  filterModelsForScope,
  isModelServableForScope,
  resolveServableModel,
} from "./model-policy.js";

describe("classifyCodexAuthJson", () => {
  it("classifies a ChatGPT subscription login", () => {
    expect(classifyCodexAuthJson(JSON.stringify({ auth_mode: "chatgpt", tokens: {} }))).toBe("chatgpt");
  });

  it("classifies an API-key credential", () => {
    expect(classifyCodexAuthJson(JSON.stringify({ OPENAI_API_KEY: "sk-test" }))).toBe("api_key");
  });

  it("classifies a token block without auth_mode as a ChatGPT login", () => {
    expect(classifyCodexAuthJson(JSON.stringify({ tokens: { access_token: "abc" } }))).toBe("chatgpt");
  });

  it("returns unknown for missing, empty, or unparsable input", () => {
    expect(classifyCodexAuthJson(null)).toBe("unknown");
    expect(classifyCodexAuthJson("")).toBe("unknown");
    expect(classifyCodexAuthJson("   ")).toBe("unknown");
    expect(classifyCodexAuthJson("{not json")).toBe("unknown");
    expect(classifyCodexAuthJson(JSON.stringify({ tokens: {} }))).toBe("unknown");
  });

  it("never widens on an API key of zero length", () => {
    expect(classifyCodexAuthJson(JSON.stringify({ OPENAI_API_KEY: "  " }))).toBe("unknown");
  });
});

describe("isModelServableForScope", () => {
  it("rejects ChatGPT-unservable models on a ChatGPT credential", () => {
    for (const model of ["gpt-5.4", "gpt-5.3-codex", "gpt-5.3-codex-spark"]) {
      expect(isModelServableForScope(model, "chatgpt")).toBe(false);
    }
  });

  it("accepts the ChatGPT fallback model", () => {
    expect(isModelServableForScope("gpt-6-astra", "chatgpt")).toBe(true);
  });

  it("accepts every known model on a non-ChatGPT credential", () => {
    for (const scope of ["api_key", "unknown"] as const) {
      for (const model of ["gpt-5.4", "gpt-5.3-codex", "gpt-5.3-codex-spark"]) {
        expect(isModelServableForScope(model, scope)).toBe(true);
      }
    }
  });

  it("treats an empty model id as not servable", () => {
    expect(isModelServableForScope("", "chatgpt")).toBe(false);
    expect(isModelServableForScope("   ", "api_key")).toBe(false);
  });
});

describe("filterModelsForScope", () => {
  const models = [
    { id: "gpt-5.4", label: "gpt-5.4" },
    { id: "gpt-5.3-codex", label: "gpt-5.3-codex" },
    { id: "gpt-5.3-codex-spark", label: "gpt-5.3-codex-spark" },
    { id: "gpt-6-astra", label: "gpt-6-astra" },
  ];

  it("drops ChatGPT-unservable models from the picker", () => {
    const filtered = filterModelsForScope(models, "chatgpt");
    expect(filtered.map((model) => model.id)).toEqual(["gpt-6-astra"]);
  });

  it("passes the list through untouched for API-key and unknown scopes", () => {
    expect(filterModelsForScope(models, "api_key")).toEqual(models);
    expect(filterModelsForScope(models, "unknown")).toEqual(models);
  });
});

describe("resolveServableModel", () => {
  it("returns null for an unset model so the caller omits --model", () => {
    expect(resolveServableModel(null, "chatgpt")).toBeNull();
    expect(resolveServableModel("", "chatgpt")).toBeNull();
    expect(resolveServableModel(undefined, "api_key")).toBeNull();
  });

  it("passes a servable model through unchanged", () => {
    expect(resolveServableModel("gpt-6-astra", "chatgpt")).toBe("gpt-6-astra");
  });

  it("swaps an unservable model for the ChatGPT fallback", () => {
    expect(resolveServableModel("gpt-5.3-codex-spark", "chatgpt")).toBe("gpt-6-astra");
    expect(resolveServableModel("gpt-5.4", "chatgpt")).toBe("gpt-6-astra");
    expect(resolveServableModel("gpt-5.3-codex", "chatgpt")).toBe("gpt-6-astra");
  });

  it("leaves the model alone for non-ChatGPT scopes", () => {
    expect(resolveServableModel("gpt-5.4", "api_key")).toBe("gpt-5.4");
    expect(resolveServableModel("gpt-5.4", "unknown")).toBe("gpt-5.4");
  });

  it("trims surrounding whitespace", () => {
    expect(resolveServableModel("  gpt-6-astra  ", "chatgpt")).toBe("gpt-6-astra");
  });
});

describe("buildCodexExecArgs modelOverride (RUAAAAA-5276)", () => {
  it("prefers the override over the configured model", () => {
    const result = buildCodexExecArgs(
      { model: "gpt-5.4" },
      { modelOverride: "gpt-6-astra" },
    );
    expect(result.model).toBe("gpt-6-astra");
    expect(result.args).toContain("--model");
    expect(result.args[result.args.indexOf("--model") + 1]).toBe("gpt-6-astra");
  });

  it("keeps the configured model when no override is supplied", () => {
    const result = buildCodexExecArgs({ model: "gpt-5.4" });
    expect(result.model).toBe("gpt-5.4");
  });

  it("omits --model when neither the config nor the override sets one", () => {
    const result = buildCodexExecArgs({}, { modelOverride: null });
    expect(result.model).toBe("");
    expect(result.args).not.toContain("--model");
  });
});

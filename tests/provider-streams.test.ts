import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteCredentialsFile, saveCredentials } from "../src/auth/credential-store.js";
import { adaptOpenAIToZed, rememberThoughtSignature } from "../src/bridge/adapter.js";
import { startBridgeServer } from "../src/bridge/server.js";

const ZED_URL = "https://cloud.zed.dev/completions";

function zedResponse(lines: unknown[]): Response {
  return new Response(lines.map((l) => JSON.stringify(l)).join("\n") + "\n", { status: 200 });
}

/** Runs one streaming chat request through the bridge against a mocked Zed upstream; returns merged deltas. */
async function chat(model: string, upstream: unknown[]) {
  const realFetch = global.fetch;
  global.fetch = vi.fn((url: string | URL | Request, init?: RequestInit) =>
    String(url) === ZED_URL ? Promise.resolve(zedResponse(upstream)) : realFetch(url, init),
  ) as typeof fetch;
  const bridge = await startBridgeServer(0);
  try {
    const res = await fetch(`${bridge.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    let content = "";
    let reasoning = "";
    const toolCalls: Array<{ id: string; function: { name: string; arguments: string } }> = [];
    let finish: string | null = null;
    for (const line of (await res.text()).split("\n")) {
      if (!line.startsWith("data: {")) continue;
      const choice = JSON.parse(line.slice(6)).choices[0];
      content += choice.delta.content ?? "";
      reasoning += choice.delta.reasoning_content ?? "";
      toolCalls.push(...(choice.delta.tool_calls ?? []));
      if (choice.finish_reason) finish = choice.finish_reason;
    }
    return { content, reasoning, toolCalls, finish };
  } finally {
    await bridge.stop();
  }
}

describe("provider stream parsing", () => {
  beforeEach(() => saveCredentials({ accessToken: "eyJhbGciOiJIUzI1NiJ9.test.payload" }));
  afterEach(() => {
    global.fetch = fetch;
    deleteCredentialsFile();
  });

  it("OpenAI Responses: text, reasoning summary and function call", async () => {
    const out = await chat("gpt-5.5", [
      { event: { type: "response.created", response: {} } },
      { event: { type: "response.reasoning_summary_text.delta", delta: "thinking" } },
      { event: { type: "response.output_text.delta", delta: "Hi" } },
      { event: { type: "response.output_text.delta", delta: "!" } },
      { event: { type: "response.output_item.added", output_index: 1, item: { type: "function_call", call_id: "call_1", name: "read", arguments: "" } } },
      { event: { type: "response.function_call_arguments.delta", output_index: 1, delta: '{"path":' } },
      { event: { type: "response.function_call_arguments.delta", output_index: 1, delta: '"a"}' } },
      { event: { type: "response.output_item.done", output_index: 1, item: { type: "function_call", call_id: "call_1", name: "read", arguments: '{"path":"a"}' } } },
      { event: { type: "response.completed", response: {} } },
    ]);
    expect(out.content).toBe("Hi!");
    expect(out.reasoning).toBe("thinking");
    expect(out.toolCalls).toHaveLength(1);
    expect(out.toolCalls[0]).toMatchObject({ id: "call_1", function: { name: "read", arguments: '{"path":"a"}' } });
    expect(out.finish).toBe("tool_calls");
  });

  it("OpenAI Responses: response.failed surfaces the error instead of an empty stop", async () => {
    const out = await chat("gpt-5.5", [{ event: { type: "response.failed", response: { error: { message: "quota exceeded" } } } }]);
    expect(out.content).toContain("quota exceeded");
  });

  it("Gemini: text, thought and functionCall parts", async () => {
    const out = await chat("gemini-3.5-flash", [
      { event: { candidates: [{ content: { role: "model", parts: [{ text: "mull", thought: true }, { text: "Hello" }] } }] } },
      { event: { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "read", args: { path: "a" } }, thoughtSignature: "sig" }] } }] } },
      { event: { candidates: [{ content: { role: "model", parts: [{ text: "" }] }, finishReason: "STOP" }] } },
      { status: "stream_ended" },
    ]);
    expect(out.content).toBe("Hello");
    expect(out.reasoning).toBe("mull");
    expect(out.toolCalls[0]!.function).toEqual({ name: "read", arguments: '{"path":"a"}' });
    expect(out.finish).toBe("tool_calls");
  });
});

describe("request building", () => {
  const history = (model: string, id: string) => ({
    model,
    messages: [
      { role: "user" as const, content: "read it" },
      { role: "assistant" as const, content: null, tool_calls: [{ id, type: "function" as const, function: { name: "read", arguments: '{"path":"a"}' } }] },
      { role: "tool" as const, tool_call_id: id, content: "file body" },
    ],
  });

  it("Anthropic tool_result carries is_error (Zed rejects it otherwise)", () => {
    const req = adaptOpenAIToZed(history("claude-sonnet-5-5", "toolu_1"));
    const result = (req.provider_request as { messages: Array<{ content: Array<Record<string, unknown>> }> }).messages[2]!.content[0]!;
    expect(result).toMatchObject({ type: "tool_result", tool_use_id: "toolu_1", is_error: false });
  });

  it("Gemini replays the remembered thoughtSignature, else Google's skip value", () => {
    rememberThoughtSignature("known", "real-sig");
    const part = (id: string) =>
      (adaptOpenAIToZed(history("gemini-3.5-flash", id)).provider_request as { contents: Array<{ parts: Array<Record<string, unknown>> }> }).contents[1]!.parts[0]!;
    expect(part("known").thoughtSignature).toBe("real-sig");
    expect(part("unknown").thoughtSignature).toBe("skip_thought_signature_validator");
  });

  describe("reasoning_effort mapping", () => {
    const pr = (model: string, effort: string | undefined, max_tokens?: number) =>
      adaptOpenAIToZed({ model, reasoning_effort: effort, max_tokens, messages: [{ role: "user", content: "x" }] });

    it("sends nothing when thinking is off", () => {
      for (const m of ["claude-sonnet-4-6", "gpt-5.5", "gemini-3.5-flash"]) {
        for (const e of [undefined, "none"]) {
          const p = pr(m, e).provider_request;
          expect(p.thinking ?? p.reasoning ?? p.generationConfig).toBeUndefined();
        }
      }
    });

    it("Claude 5+ uses adaptive thinking + output_config.effort (type=enabled is rejected)", () => {
      const p = pr("claude-sonnet-5-5", "minimal").provider_request;
      expect(p.thinking).toEqual({ type: "adaptive" });
      expect(p.output_config).toEqual({ effort: "low" });
    });

    it("Claude 4.x uses a token budget below max_tokens and forces temperature 1", () => {
      const req = adaptOpenAIToZed({ model: "claude-sonnet-4-6", reasoning_effort: "xhigh", max_tokens: 8000, temperature: 0.2, messages: [{ role: "user", content: "x" }] });
      expect(req.provider_request.thinking).toEqual({ type: "enabled", budget_tokens: 7999 });
      expect(req.temperature).toBe(1);
      expect(pr("claude-sonnet-4-6", "high", 1000).provider_request.thinking).toBeUndefined();
    });

    it("GPT clamps to values each model accepts", () => {
      expect(pr("gpt-5.5", "minimal").provider_request.reasoning).toEqual({ effort: "low", summary: "auto" });
      expect(pr("gpt-5.5", "max").provider_request.reasoning).toEqual({ effort: "xhigh", summary: "auto" });
      expect(pr("gpt-5-mini", "xhigh").provider_request.reasoning).toEqual({ effort: "high", summary: "auto" });
      expect(pr("gpt-5-mini", "minimal").provider_request.reasoning).toEqual({ effort: "minimal", summary: "auto" });
    });

    it("Gemini uses uppercase thinkingLevel; Pro has no MINIMAL", () => {
      const level = (m: string, e: string) => (pr(m, e).provider_request.generationConfig as { thinkingConfig: { thinkingLevel: string; includeThoughts: boolean } }).thinkingConfig;
      expect(level("gemini-3.5-flash", "minimal")).toEqual({ thinkingLevel: "MINIMAL", includeThoughts: true });
      expect(level("gemini-3.1-pro-preview", "minimal").thinkingLevel).toBe("LOW");
      expect(level("gemini-3.5-flash", "xhigh").thinkingLevel).toBe("HIGH");
    });
  });
});

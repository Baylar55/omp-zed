import * as crypto from "node:crypto";
const MODEL_ALIASES = {
    "claude-sonnet-5": "claude-sonnet-5",
    "claude-sonnet-4-6": "claude-sonnet-4-6",
    "claude-sonnet-4-5": "claude-sonnet-4-5",
    "claude-haiku-4-5": "claude-haiku-4-5",
    "gpt-5-6-sol": "gpt-5.6-sol", "gpt-5-6-terra": "gpt-5.6-terra", "gpt-5-6-luna": "gpt-5.6-luna",
    "gpt-5-5": "gpt-5.5", "gpt-5-4": "gpt-5.4", "gpt-5-3-codex": "gpt-5.3-codex", "gpt-5-2": "gpt-5.2",
    "gpt-5-mini": "gpt-5-mini", "gpt-5-nano": "gpt-5-nano",
    "gemini-3-1-pro": "gemini-3.1-pro-preview", "gemini-3-1-pro-preview": "gemini-3.1-pro-preview",
    "gemini-3-5-flash": "gemini-3.5-flash", "gemini-3-flash": "gemini-3-flash", "gemini-3-0-flash": "gemini-3-flash",
    luna: "gpt-5.6-luna", "gpt-luna": "gpt-5.6-luna", sol: "gpt-5.6-sol", "gpt-sol": "gpt-5.6-sol", terra: "gpt-5.6-terra", "gpt-terra": "gpt-5.6-terra",
};
export function normalizeModelId(modelId) {
    const raw = modelId.replace(/^zed\//i, "").trim().toLowerCase();
    const key = raw.replace(/\./g, "-");
    if (MODEL_ALIASES[key])
        return MODEL_ALIASES[key];
    if (MODEL_ALIASES[raw])
        return MODEL_ALIASES[raw];
    if (key.includes("luna"))
        return "gpt-5.6-luna";
    if (key.includes("sol"))
        return "gpt-5.6-sol";
    if (key.includes("terra"))
        return "gpt-5.6-terra";
    return raw;
}
/**
 * Resolves the Zed provider key for a given model id.
 */
export function getZedProvider(modelId) {
    const clean = normalizeModelId(modelId);
    if (clean.startsWith("claude-"))
        return "anthropic";
    if (clean.startsWith("gpt-") || clean.includes("luna") || clean.includes("sol") || clean.includes("terra"))
        return "open_ai";
    if (clean.startsWith("gemini-"))
        return "google";
    return "anthropic";
}
/**
 * Extracts pure string text from an OpenAI message content field.
 */
export function extractTextContent(content) {
    if (!content)
        return "";
    if (typeof content === "string")
        return content;
    return content
        .map((part) => (part.type === "text" && part.text ? part.text : ""))
        .join("\n");
}
function safeJsonParse(str) {
    if (!str)
        return null;
    try {
        return JSON.parse(str);
    }
    catch {
        return null;
    }
}
function parseDataUrl(url) {
    const m = url.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s);
    return m ? { mime: m[1], data: m[2] } : null;
}
function toolContent(m) {
    if (typeof m.content === "string")
        return m.content;
    if (Array.isArray(m.content))
        return m.content.map((b) => b.text ?? "").join("");
    return m.content ? JSON.stringify(m.content) : "";
}
function extractUserBlocks(content) {
    if (typeof content === "string")
        return content ? [{ text: content }] : [];
    if (!Array.isArray(content))
        return [];
    const blocks = [];
    for (const b of content) {
        if (!b)
            continue;
        if ((b.type === "text" || b.type === "input_text") && b.text) {
            blocks.push({ text: b.text });
        }
        else if (b.type === "image_url" || b.type === "image" || b.type === "input_image") {
            const url = typeof b.image_url === "object" ? b.image_url?.url : (typeof b.image_url === "string" ? b.image_url : "");
            if (url) {
                const d = parseDataUrl(url);
                blocks.push(d ? { mime: d.mime, data: d.data, url } : { url });
            }
        }
    }
    return blocks;
}
function extractSystemAndMessages(messages) {
    const systemParts = [];
    const cleanMessages = [];
    for (const m of messages || []) {
        if (!m)
            continue;
        if (m.role === "system" || m.role === "developer") {
            const text = typeof m.content === "string"
                ? m.content
                : (m.content || []).map((b) => b.text || "").join("");
            if (text)
                systemParts.push(text);
            continue;
        }
        if (m.role === "user") {
            const rawText = typeof m.content === "string"
                ? m.content
                : (m.content || []).map((b) => b.text || "").join("\n");
            if (rawText.includes("<system-reminder>") || rawText.includes("<system-reminder")) {
                const withoutReminder = rawText.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
                const reminderMatch = rawText.match(/<system-reminder>[\s\S]*?<\/system-reminder>/g);
                if (reminderMatch)
                    systemParts.push(reminderMatch.join("\n"));
                if (withoutReminder) {
                    cleanMessages.push({ ...m, content: withoutReminder });
                }
                continue;
            }
        }
        cleanMessages.push(m);
    }
    const combinedSystem = systemParts.join("\n\n");
    const systemPrompt = combinedSystem
        ? `${combinedSystem}\n\n## Tool Protocol\n- Use native tool_use API only.\n- NEVER output XML tags like <tool>.\n- The user already sees tool output. Do not repeat it.`
        : "";
    return { cleanMessages, systemPrompt };
}
function buildAnthropicRequest(modelId, cleanMessages, tools, systemPrompt, maxTokens) {
    const messages = [];
    for (const m of cleanMessages) {
        if (m.role === "user") {
            const blocks = extractUserBlocks(m.content).map((b) => b.text !== undefined ? { type: "text", text: b.text } : { type: "image", source: { type: "base64", media_type: b.mime, data: b.data } });
            if (blocks.length)
                messages.push({ role: "user", content: blocks });
        }
        else if (m.role === "assistant") {
            const blocks = [];
            const text = extractTextContent(m.content);
            if (text)
                blocks.push({ type: "text", text });
            for (const tc of m.tool_calls || [])
                blocks.push({ type: "tool_use", id: tc.id || crypto.randomUUID(), name: tc.function?.name, input: safeJsonParse(tc.function?.arguments) || {} });
            if (blocks.length)
                messages.push({ role: "assistant", content: blocks });
        }
        else if (m.role === "tool") {
            messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: m.tool_call_id, is_error: false, content: [{ type: "text", text: toolContent(m) || "" }] }] });
        }
    }
    const mappedTools = tools?.length ? tools.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters || { type: "object", properties: {} } })) : undefined;
    return { model: modelId, stream: true, max_tokens: maxTokens, messages, ...(systemPrompt ? { system: systemPrompt } : {}), ...(mappedTools?.length ? { tools: mappedTools } : {}) };
}
function buildOpenAiRequest(modelId, cleanMessages, tools, systemPrompt, maxTokens) {
    const input = [];
    for (const m of cleanMessages) {
        if (m.role === "user") {
            const blocks = extractUserBlocks(m.content).map((b) => b.text !== undefined ? { type: "input_text", text: b.text } : { type: "input_image", image_url: b.url });
            if (blocks.length)
                input.push({ type: "message", role: "user", content: blocks });
        }
        else if (m.role === "assistant") {
            const text = extractTextContent(m.content);
            if (text)
                input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
            for (const tc of m.tool_calls || [])
                input.push({ type: "function_call", call_id: tc.id || crypto.randomUUID(), name: tc.function?.name || "unknown", arguments: tc.function?.arguments || "{}" });
        }
        else if (m.role === "tool") {
            input.push({ type: "function_call_output", call_id: m.tool_call_id, output: toolContent(m) || "" });
        }
    }
    const mappedTools = tools?.length ? tools.map((t) => ({ type: "function", name: t.function.name, description: t.function.description, parameters: t.function.parameters || { type: "object", properties: {} } })) : undefined;
    return { model: modelId, stream: true, input, max_output_tokens: maxTokens, ...(systemPrompt ? { instructions: systemPrompt } : {}), ...(mappedTools?.length ? { tools: mappedTools } : {}) };
}
// Gemini 3 rejects replayed functionCall parts without their thoughtSignature; OpenAI chat has no field for it,
// so remember it by tool-call id. Unknown ids (e.g. after a restart) fall back to Google's documented skip value.
const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";
const MAX_SIGNATURES = 500;
const thoughtSignatures = new Map();
export function rememberThoughtSignature(toolCallId, signature) {
    if (!signature)
        return;
    if (thoughtSignatures.size >= MAX_SIGNATURES)
        thoughtSignatures.delete(thoughtSignatures.keys().next().value);
    thoughtSignatures.set(toolCallId, signature);
}
function buildGoogleRequest(modelId, cleanMessages, tools, systemPrompt, maxTokens) {
    const contents = [];
    const toolNameMap = new Map();
    for (const m of cleanMessages) {
        if (m.role === "user") {
            const parts = extractUserBlocks(m.content).map((b) => b.text !== undefined ? { text: b.text } : { inlineData: { mimeType: b.mime, data: b.data } });
            if (parts.length)
                contents.push({ role: "user", parts });
        }
        else if (m.role === "assistant") {
            const parts = [];
            const text = extractTextContent(m.content);
            if (text)
                parts.push({ text });
            for (const tc of m.tool_calls || []) {
                if (tc.id && tc.function?.name)
                    toolNameMap.set(tc.id, tc.function.name);
                const signature = (tc.id && thoughtSignatures.get(tc.id)) || SKIP_THOUGHT_SIGNATURE;
                parts.push({ functionCall: { name: tc.function?.name || "unknown", args: safeJsonParse(tc.function?.arguments) || {} }, thoughtSignature: signature });
            }
            if (parts.length)
                contents.push({ role: "model", parts });
        }
        else if (m.role === "tool") {
            const toolName = (m.tool_call_id && toolNameMap.get(m.tool_call_id)) || "tool";
            contents.push({ role: "user", parts: [{ functionResponse: { name: toolName, response: { output: toolContent(m) || "" } } }] });
        }
    }
    const mappedTools = tools?.length ? [{ functionDeclarations: tools.map((t) => ({ name: t.function.name, description: t.function.description, parameters: t.function.parameters || { type: "OBJECT", properties: {} } })) }] : undefined;
    return { model: modelId, stream: true, contents, max_output_tokens: maxTokens, ...(systemPrompt ? { systemInstruction: { parts: [{ text: systemPrompt }] } } : {}), ...(mappedTools?.length ? { tools: mappedTools } : {}) };
}
const CLAUDE_BUDGETS = { minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 32000, max: 32000 };
const CLAUDE_ADAPTIVE_EFFORT = { minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };
const OPENAI_EFFORT = { minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "xhigh" };
const OPENAI_EFFORT_MINI = { minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" };
const GEMINI_LEVEL = { minimal: "MINIMAL", low: "LOW", medium: "MEDIUM", high: "HIGH", xhigh: "HIGH", max: "HIGH" };
const GEMINI_LEVEL_PRO = { ...GEMINI_LEVEL, minimal: "LOW" };
/**
 * Maps omp's `reasoning_effort` onto each provider's native thinking fields.
 * Value sets verified against live Zed endpoint: Claude 5+ rejects `thinking.type=enabled` (adaptive + output_config.effort only),
 * gpt-5-mini/nano reject xhigh, gpt-5.5+ reject minimal, Gemini Pro rejects MINIMAL.
 */
function thinkingFields(provider, modelId, effort, maxTokens) {
    if (!effort || effort === "none")
        return null;
    if (provider === "open_ai") {
        const table = /^gpt-5-(mini|nano)/.test(modelId) ? OPENAI_EFFORT_MINI : OPENAI_EFFORT;
        const mapped = table[effort];
        return mapped ? { reasoning: { effort: mapped, summary: "auto" } } : null;
    }
    if (provider === "google") {
        const level = (modelId.includes("pro") ? GEMINI_LEVEL_PRO : GEMINI_LEVEL)[effort];
        return level ? { generationConfig: { thinkingConfig: { thinkingLevel: level, includeThoughts: true } } } : null;
    }
    const major = Number(/^claude-[a-z]+-(\d+)/.exec(modelId)?.[1] ?? 0);
    if (major >= 5) {
        const mapped = CLAUDE_ADAPTIVE_EFFORT[effort];
        return mapped ? { thinking: { type: "adaptive" }, output_config: { effort: mapped } } : null;
    }
    const budget = Math.min(CLAUDE_BUDGETS[effort] ?? 0, maxTokens - 1);
    return budget >= 1024 ? { thinking: { type: "enabled", budget_tokens: budget } } : null;
}
/**
 * Converts an OpenAI chat completions request into Zed's proprietary completions envelope.
 * Verified against live endpoint 2026-08-12 (cloud.zed.dev/completions).
 */
export function adaptOpenAIToZed(req) {
    const modelId = normalizeModelId(req.model);
    const provider = getZedProvider(modelId);
    const { cleanMessages, systemPrompt } = extractSystemAndMessages(req.messages);
    const tools = Array.isArray(req.tools) && req.tools.length > 0 ? req.tools : undefined;
    const maxTokens = req.max_tokens || req.max_completion_tokens || 16384;
    const effort = req.reasoning_effort;
    let providerRequest;
    if (provider === "open_ai") {
        providerRequest = buildOpenAiRequest(modelId, cleanMessages, tools, systemPrompt, maxTokens);
    }
    else if (provider === "google") {
        providerRequest = buildGoogleRequest(modelId, cleanMessages, tools, systemPrompt, maxTokens);
    }
    else {
        providerRequest = buildAnthropicRequest(modelId, cleanMessages, tools, systemPrompt, maxTokens);
    }
    const thinking = thinkingFields(provider, modelId, effort, maxTokens);
    Object.assign(providerRequest, thinking);
    // Anthropic only allows thinking with temperature 1.
    const temperature = provider === "anthropic" && thinking ? 1.0 : (req.temperature ?? 1.0);
    return {
        thread_id: crypto.randomUUID(),
        prompt_id: crypto.randomUUID(),
        intent: "user_prompt",
        provider,
        model: modelId,
        provider_request: providerRequest,
        system: systemPrompt,
        temperature,
    };
}
/**
 * Creates an OpenAI SSE data chunk formatted as `data: {...}\n\n`.
 */
export function createSSEChunk(id, model, delta, finishReason = null) {
    const chunk = {
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
            {
                index: 0,
                delta,
                finish_reason: finishReason,
            },
        ],
    };
    return `data: ${JSON.stringify(chunk)}\n\n`;
}
/**
 * Creates a standard non-streaming OpenAI chat completion response object.
 */
export function createChatCompletionResponse(id, model, content, promptTokens = 0, completionTokens = 0) {
    return {
        id,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
            {
                index: 0,
                message: {
                    role: "assistant",
                    content,
                },
                finish_reason: "stop",
            },
        ],
        usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
        },
    };
}
//# sourceMappingURL=adapter.js.map
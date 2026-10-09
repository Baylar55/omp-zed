import * as http from "node:http";
import * as crypto from "node:crypto";
import { loadCredentials } from "../auth/credential-store.js";
import { adaptOpenAIToZed, createChatCompletionResponse, createSSEChunk, rememberThoughtSignature } from "./adapter.js";
import { ZedCloudClient } from "./client.js";
import { getCachedZedModels } from "../models.js";
import { recordTokenUsage } from "../usage/tracker.js";
const MAX_PAYLOAD_BYTES = 15 * 1024 * 1024; // 15 MB
function isLoopback(input) {
    if (!input)
        return true;
    const trimmed = input.trim().toLowerCase();
    if (trimmed === "::1" || trimmed.startsWith("[::1]"))
        return true;
    try {
        const host = new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`).hostname.toLowerCase();
        return host === "127.0.0.1" || host === "localhost" || host === "::1";
    }
    catch {
        const host = trimmed.split(":")[0]?.replace(/^\[|\]$/g, "");
        return host === "127.0.0.1" || host === "localhost" || host === "::1";
    }
}
function estTokens(text) {
    return text ? Math.max(1, Math.ceil(text.length / 4)) : 0;
}
function writeSseError(res, id, model, error) {
    const errChunk = JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { content: error }, finish_reason: "stop" }],
    });
    res.write(`data: ${errChunk}\n\n`);
    res.write(createSSEChunk(id, model, {}, "stop"));
    res.write("data: [DONE]\n\n");
}
/**
 * Creates and starts an in-process OpenAI-compatible HTTP bridge server for Zed.
 */
export async function startBridgeServer(preferredPort = 38142) {
    const client = new ZedCloudClient();
    const server = http.createServer(async (req, res) => {
        const hostHeader = req.headers["host"];
        if (!isLoopback(hostHeader)) {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: "Forbidden: untrusted host header", type: "security_error" } }));
            return;
        }
        const originHeader = req.headers["origin"];
        if (originHeader) {
            if (!isLoopback(originHeader)) {
                res.writeHead(403, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: { message: "Forbidden: cross-origin requests from external web origins are not permitted", type: "security_error" } }));
                return;
            }
            res.setHeader("Access-Control-Allow-Origin", originHeader);
            res.setHeader("Vary", "Origin");
        }
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
        if (req.method === "OPTIONS") {
            res.writeHead(204);
            res.end();
            return;
        }
        const urlPath = req.url?.split("?")[0] || "";
        // 1. Health check
        if (urlPath === "/health" || urlPath === "/") {
            const creds = loadCredentials();
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
                status: "ok",
                service: "omp-zed-bridge",
                authenticated: Boolean(creds?.accessToken || creds?.sessionCookie),
            }));
            return;
        }
        // 2. GET /v1/models
        if (req.method === "GET" && (urlPath === "/v1/models" || urlPath === "/models")) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
                object: "list",
                data: getCachedZedModels().map((m) => ({
                    id: m.id,
                    object: "model",
                    created: 1700000000,
                    owned_by: "zed",
                })),
            }));
            return;
        }
        // 3. POST /v1/chat/completions
        if (req.method === "POST" && (urlPath === "/v1/chat/completions" || urlPath === "/chat/completions")) {
            let bodyStr = "";
            let exceeded = false;
            req.on("data", (chunk) => {
                if (exceeded)
                    return;
                if (bodyStr.length + chunk.length > MAX_PAYLOAD_BYTES) {
                    exceeded = true;
                    res.writeHead(413, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({
                        error: {
                            message: "Payload too large. Maximum allowed size is 15MB.",
                            type: "invalid_request_error",
                            code: "payload_too_large",
                        },
                    }));
                    req.destroy();
                    return;
                }
                bodyStr += chunk;
            });
            req.on("end", async () => {
                if (exceeded)
                    return;
                try {
                    const creds = loadCredentials();
                    if (!creds || (!creds.accessToken && !creds.sessionCookie)) {
                        res.writeHead(401, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({
                            error: {
                                message: "No Zed credentials found. Please run '/zed login' inside OMP.",
                                type: "authentication_error",
                                code: "unauthorized",
                            },
                        }));
                        return;
                    }
                    const chatReq = JSON.parse(bodyStr);
                    const zedReq = adaptOpenAIToZed(chatReq);
                    const completionId = `chatcmpl-${crypto.randomUUID()}`;
                    const isStream = chatReq.stream ?? true;
                    if (isStream) {
                        res.writeHead(200, {
                            "Content-Type": "text/event-stream; charset=utf-8",
                            "Cache-Control": "no-cache",
                            "Connection": "keep-alive",
                        });
                        // Initial role chunk
                        res.write(createSSEChunk(completionId, chatReq.model, { role: "assistant" }));
                        let totalCompletionTokens = 0;
                        let hasToolCalls = false;
                        try {
                            for await (const event of client.streamCompletion(zedReq, creds)) {
                                if (event.error) {
                                    writeSseError(res, completionId, chatReq.model, `Error: ${event.error}`);
                                    break;
                                }
                                if (event.done) {
                                    break;
                                }
                                if (event.reasoning) {
                                    totalCompletionTokens += estTokens(event.reasoning);
                                    res.write(createSSEChunk(completionId, chatReq.model, { reasoning_content: event.reasoning }));
                                }
                                if (event.text) {
                                    totalCompletionTokens += estTokens(event.text);
                                    res.write(createSSEChunk(completionId, chatReq.model, { content: event.text }));
                                }
                                if (event.toolCall) {
                                    hasToolCalls = true;
                                    rememberThoughtSignature(event.toolCall.id, event.toolCall.thoughtSignature);
                                    totalCompletionTokens += estTokens(event.toolCall.arguments);
                                    res.write(createSSEChunk(completionId, chatReq.model, {
                                        tool_calls: [
                                            {
                                                index: event.toolCall.index ?? 0,
                                                id: event.toolCall.id,
                                                type: "function",
                                                function: {
                                                    name: event.toolCall.name,
                                                    arguments: event.toolCall.arguments,
                                                },
                                            },
                                        ],
                                    }));
                                }
                            }
                            res.write(createSSEChunk(completionId, chatReq.model, {}, hasToolCalls ? "tool_calls" : "stop"));
                            res.write("data: [DONE]\n\n");
                            res.end();
                            recordTokenUsage(chatReq.model, estTokens(bodyStr), totalCompletionTokens);
                        }
                        catch (streamErr) {
                            const errorMsg = streamErr instanceof Error ? streamErr.message : String(streamErr);
                            try {
                                writeSseError(res, completionId, chatReq.model, `\n\n[Zed Error: ${errorMsg}]`);
                            }
                            catch { }
                            try {
                                res.end();
                            }
                            catch { }
                        }
                    }
                    else {
                        try {
                            const result = await client.complete(zedReq, creds);
                            const promptEstTokens = estTokens(bodyStr);
                            const complEstTokens = estTokens(result.content);
                            recordTokenUsage(chatReq.model, promptEstTokens, complEstTokens);
                            const respObj = createChatCompletionResponse(completionId, chatReq.model, result.content, promptEstTokens, complEstTokens);
                            res.writeHead(200, { "Content-Type": "application/json" });
                            res.end(JSON.stringify(respObj));
                        }
                        catch (nonStreamErr) {
                            const errorMsg = nonStreamErr instanceof Error ? nonStreamErr.message : String(nonStreamErr);
                            if (!res.headersSent) {
                                res.writeHead(500, { "Content-Type": "application/json" });
                                res.end(JSON.stringify({ error: { message: errorMsg, type: "api_error" } }));
                            }
                            else {
                                try {
                                    res.end();
                                }
                                catch { }
                            }
                        }
                    }
                }
                catch (err) {
                    const errorMsg = err instanceof Error ? err.message : String(err);
                    if (!res.headersSent) {
                        res.writeHead(500, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ error: { message: errorMsg, type: "api_error" } }));
                    }
                    else {
                        try {
                            res.end();
                        }
                        catch { }
                    }
                }
            });
            return;
        }
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Not found" } }));
    });
    const listen = (port) => new Promise((resolve, reject) => {
        const onErr = (err) => {
            if (err.code === "EADDRINUSE") {
                server.once("error", reject);
                server.listen(0, "127.0.0.1", () => {
                    const a = server.address();
                    resolve(typeof a === "object" && a ? a.port : 0);
                });
            }
            else
                reject(err);
        };
        server.once("error", onErr);
        server.listen(port, "127.0.0.1", () => {
            server.off("error", onErr);
            const a = server.address();
            resolve(typeof a === "object" && a ? a.port : port);
        });
    });
    const actualPort = await listen(preferredPort);
    return { port: actualPort, baseUrl: `http://127.0.0.1:${actualPort}/v1`, stop: () => new Promise((r) => server.close(() => r())) };
}
//# sourceMappingURL=server.js.map
/**
 * OpenAI Chat Completions and Zed Protocol Types.
 */
export interface OpenAIMessage {
    role: "system" | "user" | "assistant" | "tool" | "developer";
    content?: string | Array<{
        type: string;
        text?: string;
        image_url?: {
            url: string;
        };
    }>;
    name?: string;
    tool_call_id?: string;
    tool_calls?: OpenAIToolCall[];
}
export interface OpenAIToolCall {
    id: string;
    type: "function";
    function: {
        name: string;
        arguments: string;
    };
}
export interface OpenAITool {
    type: "function";
    function: {
        name: string;
        description?: string;
        parameters?: Record<string, unknown>;
    };
}
export interface OpenAIChatRequest {
    model: string;
    messages: OpenAIMessage[];
    tools?: OpenAITool[];
    tool_choice?: unknown;
    temperature?: number;
    top_p?: number;
    stream?: boolean;
    max_tokens?: number;
    max_completion_tokens?: number;
    reasoning_effort?: string;
}
export interface OpenAIChatChunk {
    id: string;
    object: "chat.completion.chunk";
    created: number;
    model: string;
    choices: Array<{
        index: number;
        delta: {
            role?: string;
            content?: string | null;
            reasoning_content?: string;
            tool_calls?: Array<{
                index: number;
                id?: string;
                type?: string;
                function?: {
                    name?: string;
                    arguments?: string;
                };
            }>;
        };
        finish_reason: string | null;
    }>;
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}
export interface OpenAIChatResponse {
    id: string;
    object: "chat.completion";
    created: number;
    model: string;
    choices: Array<{
        index: number;
        message: OpenAIMessage;
        finish_reason: string;
    }>;
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}
export declare const ZED_ENDPOINT = "https://cloud.zed.dev/completions";
export declare const ZED_VERSION = "0.228.0+stable.203.8421009ef8a022df1196d54bb42fd94366ec0988";
export interface ZedRawModel {
    provider: string;
    id: string;
    display_name: string;
    max_token_count?: number;
    max_output_tokens?: number;
    supports_thinking?: boolean;
    supports_images?: boolean;
    is_disabled?: boolean;
}
export interface ZedAssistantRequest {
    thread_id: string;
    prompt_id: string;
    intent: "user_prompt";
    provider: string;
    model: string;
    provider_request: {
        model: string;
        stream?: boolean;
        max_tokens?: number;
        max_output_tokens?: number;
        messages?: Array<{
            role: string;
            content: unknown[];
        }>;
        input?: Array<unknown>;
        contents?: Array<unknown>;
        tools?: unknown[];
        system?: string;
        instructions?: string;
        systemInstruction?: unknown;
        [key: string]: unknown;
    };
    system: string;
    temperature: number;
}
//# sourceMappingURL=types.d.ts.map
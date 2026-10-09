import type { ZedCredentials } from "../auth/types.js";
import type { ZedAssistantRequest } from "./types.js";
import { type ZedRawModel } from "./types.js";
export interface StreamEvent {
    text?: string;
    reasoning?: string;
    done?: boolean;
    error?: string;
    toolCall?: {
        id: string;
        name: string;
        arguments: string;
        index?: number;
        thoughtSignature?: string;
    };
}
/**
 * Client for dispatching completion requests to Zed Cloud.
 */
export declare class ZedCloudClient {
    private readonly baseUrl;
    private readonly version;
    private cachedJwt;
    private cachedJwtExp;
    constructor(baseUrl?: string, version?: string);
    private resolveJwt;
    private buildHeadersWithJwt;
    streamCompletion(req: ZedAssistantRequest, creds: ZedCredentials, signal?: AbortSignal): AsyncGenerator<StreamEvent, void, unknown>;
    complete(req: ZedAssistantRequest, creds: ZedCredentials, signal?: AbortSignal): Promise<{
        content: string;
        reasoning?: string;
    }>;
    fetchModels(creds: ZedCredentials, signal?: AbortSignal): Promise<ZedRawModel[]>;
}
//# sourceMappingURL=client.d.ts.map
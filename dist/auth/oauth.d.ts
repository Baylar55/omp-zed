import type { ZedCredentials } from "./types.js";
/**
 * Validates that a target URL belongs to trusted Zed domains and uses HTTPS.
 */
export declare function isValidZedUrl(targetUrl: string): boolean;
/**
 * Opens a URL in the user's default web browser across Windows, macOS, and Linux.
 */
export declare function openBrowser(targetUrl: string): void;
/**
 * Zed encrypts the token with either OAEP-SHA256 (V1) or PKCS#1 v1.5 (V0).
 * Node/Bun removed RSA_PKCS1_PADDING for private decryption (Marvin attack, CVE-2023-46809),
 * so V0 is decrypted with raw RSA and unpadded by hand. Not constant-time; fine for a one-shot local login.
 */
export declare function decryptZedToken(encryptedTokenBase64Url: string, privateKeyPem: string): string;
/**
 * Runs a local loopback server and initiates Zed's native RSA PKCS#1 sign-in flow.
 */
export declare function startOAuthFlow(preferredPort?: number): Promise<ZedCredentials>;
//# sourceMappingURL=oauth.d.ts.map
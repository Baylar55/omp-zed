import * as crypto from "node:crypto";
import * as http from "node:http";
import * as url from "node:url";
import { execFile } from "node:child_process";
import type { ZedCredentials } from "./types.js";
import { saveCredentials } from "./credential-store.js";
import { isEncryptedPayload, isPlausibleJwt } from "./token.js";

const DEFAULT_CALLBACK_PORT = 35711;

const ALLOWED_BROWSER_HOSTS: Record<string, true> = {
  "zed.dev": true,
  "dashboard.zed.dev": true,
  "cloud.zed.dev": true,
};

/**
 * Validates that a target URL belongs to trusted Zed domains and uses HTTPS.
 */
export function isValidZedUrl(targetUrl: string): boolean {
  try {
    const parsed = new URL(targetUrl);
    if (parsed.protocol !== "https:") return false;
    return Boolean(ALLOWED_BROWSER_HOSTS[parsed.hostname.toLowerCase()]);
  } catch {
    return false;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function isLocalHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return true;
  const clean = hostHeader.split(":")[0]?.toLowerCase();
  return clean === "127.0.0.1" || clean === "localhost";
}

function htmlCard(title: string, body: string, color = "#4ade80"): string {
  return `<!DOCTYPE html><html><head><title>${title}</title><style>body{font-family:system-ui,sans-serif;background:#121212;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}.card{background:#1e1e1e;padding:2.5rem;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,0.6);text-align:center;max-width:440px;border:1px solid #333}h1{color:${color};font-size:1.6rem;margin-bottom:0.75rem}p{color:#a1a1aa;font-size:1rem;line-height:1.5}</style></head><body><div class="card"><h1>${title}</h1>${body}</div></body></html>`;
}

/**
 * Opens a URL in the user's default web browser across Windows, macOS, and Linux.
 */
export function openBrowser(targetUrl: string): void {
  if (!isValidZedUrl(targetUrl)) {
    return;
  }
  const platform = process.platform;
  if (platform === "win32") {
    // cmd.exe's `start` treats `&` as a command separator and truncates the URL at the first one
    // (dropping native_app_public_key). rundll32 takes the URL verbatim.
    execFile("rundll32", ["url.dll,FileProtocolHandler", targetUrl], () => {});
  } else if (platform === "darwin") {
    execFile("open", [targetUrl], () => {});
  } else {
    execFile("xdg-open", [targetUrl], () => {});
  }
}

/**
 * Generates an RSA 2048-bit keypair formatted for Zed's PKCS#1 DER native_app_signin.
 */
function generateZedKeypair(): {
  publicKeyBase64Url: string;
  privateKeyPem: string;
} {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: "pkcs1",
      format: "der",
    },
    privateKeyEncoding: {
      type: "pkcs1",
      format: "pem",
    },
  });

  const publicKeyBase64Url = publicKey.toString("base64url");
  return { publicKeyBase64Url, privateKeyPem: privateKey };
}

/**
 * Zed encrypts the token with either OAEP-SHA256 (V1) or PKCS#1 v1.5 (V0).
 * Node/Bun removed RSA_PKCS1_PADDING for private decryption (Marvin attack, CVE-2023-46809),
 * so V0 is decrypted with raw RSA and unpadded by hand. Not constant-time; fine for a one-shot local login.
 */
export function decryptZedToken(encryptedTokenBase64Url: string, privateKeyPem: string): string {
  const buf = Buffer.from(encryptedTokenBase64Url.trim(), "base64url");
  try {
    return crypto
      .privateDecrypt({ key: privateKeyPem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, buf)
      .toString("utf-8")
      .trim();
  } catch {
    const em = crypto.privateDecrypt({ key: privateKeyPem, padding: crypto.constants.RSA_NO_PADDING }, buf);
    const sep = em.indexOf(0, 2);
    if (em[0] !== 0 || em[1] !== 2 || sep < 10) {
      throw new Error("Unsupported Zed token encryption (neither OAEP-SHA256 nor PKCS#1 v1.5)");
    }
    return em.subarray(sep + 1).toString("utf-8").trim();
  }
}

/**
 * Runs a local loopback server and initiates Zed's native RSA PKCS#1 sign-in flow.
 */
export async function startOAuthFlow(preferredPort = DEFAULT_CALLBACK_PORT): Promise<ZedCredentials> {
  return new Promise<ZedCredentials>((resolve, reject) => {
    const { publicKeyBase64Url, privateKeyPem } = generateZedKeypair();

    const server = http.createServer((req, res) => {
      try {
        const host = req.headers["host"];
        if (!isLocalHost(host)) {
          res.writeHead(403, { "Content-Type": "text/plain" });
          res.end("Forbidden: Invalid host header.");
          return;
        }

        const parsedUrl = url.parse(req.url || "", true);
        const pathname = parsedUrl.pathname;

        if (pathname !== "/callback" && pathname !== "/") {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not Found");
          return;
        }

        const query = parsedUrl.query;
        const rawAccessToken = (query["access_token"] || query["token"]) as string | undefined;
        const sessionCookie = (query["session_cookie"] || query["session"]) as string | undefined;
        const userId = query["user_id"] as string | undefined;

        if (rawAccessToken) {
          let accessToken = rawAccessToken.trim();
          const looksEncrypted = isEncryptedPayload(accessToken);

          if (looksEncrypted) {
            try {
              const decrypted = decryptZedToken(accessToken, privateKeyPem);
              if (isPlausibleJwt(decrypted) || decrypted.trim().startsWith("{")) {
                accessToken = decrypted;
              } else {
                throw new Error(`Decrypted token does not look valid: ${decrypted.slice(0, 20)}...`);
              }
            } catch (e) {
              const safeError = escapeHtml(e instanceof Error ? e.message : String(e));
              res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
              res.end(htmlCard("Decryption failed", `<p>Could not decrypt Zed token. Please close this window, run <code>/zed logout</code> then <code>/zed login</code> again.</p><p style="font-size:0.9rem">Error: ${safeError}</p>`, "#f87171"));
              server.close();
              reject(new Error(`Failed to decrypt Zed token: ${e instanceof Error ? e.message : String(e)}`));
              return;
            }
          }

          if (!isPlausibleJwt(accessToken) && !accessToken.trim().startsWith("{") && accessToken.length < 20) {
            res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
            res.end(htmlCard("Invalid token", `<p>Received token does not look valid. Please try <code>/zed login</code> again.</p>`, "#f87171"));
            server.close();
            reject(new Error(`Invalid token received from Zed (length ${accessToken.length})`));
            return;
          }

          const creds: ZedCredentials = {
            accessToken,
            sessionCookie,
            userId,
          };

          saveCredentials(creds);

          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(htmlCard("✓ Zed Pro Authenticated!", `<p>Your Zed account is now successfully connected to Oh My Pi.</p><p>You can close this browser window and return to your terminal.</p>`));

          server.close();
          resolve(creds);
        } else {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Authentication failed: No access token received in redirect.");
        }
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal error processing callback.");
        server.close();
        reject(err);
      }
    });

    server.listen(preferredPort, "127.0.0.1", () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : preferredPort;
      const signinUrl = `https://zed.dev/native_app_signin?native_app_port=${actualPort}&native_app_public_key=${publicKeyBase64Url}`;
      openBrowser(signinUrl);
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          const actualPort = typeof address === "object" && address ? address.port : preferredPort;
          const signinUrl = `https://zed.dev/native_app_signin?native_app_port=${actualPort}&native_app_public_key=${publicKeyBase64Url}`;
          openBrowser(signinUrl);
        });
      } else {
        reject(err);
      }
    });

    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("Zed login timed out after 3 minutes."));
    }, 180000);
    server.on("close", () => clearTimeout(timeout));
  });
}

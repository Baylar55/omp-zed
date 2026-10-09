import * as crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptZedToken } from "../src/auth/oauth.js";

describe("decryptZedToken", () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  const token = '{"id":1,"token":"abc.def.ghi"}';
  const enc = (padding: number, extra: object = {}) =>
    crypto.publicEncrypt({ key: publicKey, padding, ...extra }, Buffer.from(token)).toString("base64url");

  it("decrypts OAEP-SHA256", () => {
    expect(decryptZedToken(enc(crypto.constants.RSA_PKCS1_OAEP_PADDING, { oaepHash: "sha256" }), privateKey)).toBe(token);
  });

  it("decrypts PKCS#1 v1.5 even though runtime rejects that padding for private decrypt", () => {
    expect(decryptZedToken(enc(crypto.constants.RSA_PKCS1_PADDING), privateKey)).toBe(token);
  });

  it("rejects garbage", () => {
    expect(() => decryptZedToken(Buffer.alloc(256, 1).toString("base64url"), privateKey)).toThrow();
  });
});

import { createServer } from "node:http";
import net from "node:net";
import https from "node:https";
import { describe, it, expect } from "vitest";

describe("test network policy", () => {
  it("blocks fetch to non-localhost host with a stable egress code", async () => {
    await expect(fetch("https://example.invalid/policy-check")).rejects.toMatchObject({
      code: "TEST_NETWORK_EGRESS_FORBIDDEN",
      message: "TEST_NETWORK_EGRESS_FORBIDDEN"
    });
  });

  it("blocks socket createConnection to public host with stable egress code", async () => {
    expect(() => net.createConnection({
      host: "example.invalid",
      port: 443
    })).toThrowError(expect.objectContaining({
      code: "TEST_NETWORK_EGRESS_FORBIDDEN",
      message: "TEST_NETWORK_EGRESS_FORBIDDEN"
    }));
  });

  it("allows HTTP requests to localhost only", async () => {
    const server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    const localPort = await new Promise<number>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("INVALID_LISTEN_ADDRESS"));
          return;
        }
        resolve(address.port);
      });
      server.once("error", reject);
    });

    try {
      const response = await fetch(`http://127.0.0.1:${localPort}/health`);
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(body).toBe("ok");
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("blocks https.request to non-localhost host with stable egress code", async () => {
    expect(() => https.request({
      protocol: "https:",
      host: "example.invalid",
      port: 443,
      path: "/"
    })).toThrowError(expect.objectContaining({
      code: "TEST_NETWORK_EGRESS_FORBIDDEN",
      message: "TEST_NETWORK_EGRESS_FORBIDDEN"
    }));
  });
});

import http, {
  createServer
} from "node:http";
import net, {
  connect as namedNetConnect,
  createConnection as namedNetCreateConnection
} from "node:net";
import https from "node:https";
import tls, { connect as namedTlsConnect } from "node:tls";
import { describe, it, expect } from "vitest";

const blockedSocketOptions = {
  host: "example.invalid",
  port: 443,
  lookup: () => undefined
};
const blockedHttpOptions = {
  ...blockedSocketOptions,
  path: "/"
};
const TEST_RUNTIME = globalThis as {
  testNetworkPolicyNativeNamedExports?: {
    http: Pick<typeof http, "get" | "request">;
    https: Pick<typeof https, "get" | "request">;
  };
};

function expectSyncEgressBlocked(connect: () => net.Socket): void {
  let socket: net.Socket | undefined;
  try {
    expect(() => {
      socket = connect();
    }).toThrowError(expect.objectContaining({
      code: "TEST_NETWORK_EGRESS_FORBIDDEN",
      message: "TEST_NETWORK_EGRESS_FORBIDDEN"
    }));
  } finally {
    socket?.on("error", () => undefined);
    socket?.destroy();
  }
}

function expectSyncHttpEgressBlocked(request: () => http.ClientRequest): void {
  let clientRequest: http.ClientRequest | undefined;
  const originalSocketConnect = net.Socket.prototype.connect;
  const originalNetConnect = net.connect;
  const originalNetCreateConnection = net.createConnection;
  const originalTlsConnect = tls.connect;
  const lowerLayerReached = () => {
    throw new Error("TEST_NETWORK_POLICY_LOWER_LAYER_REACHED");
  };
  try {
    net.Socket.prototype.connect = lowerLayerReached as typeof net.Socket.prototype.connect;
    net.connect = lowerLayerReached as typeof net.connect;
    net.createConnection = lowerLayerReached as typeof net.createConnection;
    tls.connect = lowerLayerReached as typeof tls.connect;
    expect(() => {
      clientRequest = request();
    }).toThrowError(expect.objectContaining({
      code: "TEST_NETWORK_EGRESS_FORBIDDEN",
      message: "TEST_NETWORK_EGRESS_FORBIDDEN"
    }));
  } finally {
    net.Socket.prototype.connect = originalSocketConnect;
    net.connect = originalNetConnect;
    net.createConnection = originalNetCreateConnection;
    tls.connect = originalTlsConnect;
    clientRequest?.on("error", () => undefined);
    clientRequest?.destroy();
  }
}

function nativeNamedExports(): NonNullable<typeof TEST_RUNTIME.testNetworkPolicyNativeNamedExports> {
  const namedExports = TEST_RUNTIME.testNetworkPolicyNativeNamedExports;
  if (!namedExports) {
    throw new Error("TEST_NETWORK_POLICY_NATIVE_EXPORTS_UNAVAILABLE");
  }
  return namedExports;
}

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

  it("blocks node:net named createConnection before a non-localhost connection starts", () => {
    expectSyncEgressBlocked(() => namedNetCreateConnection(blockedSocketOptions));
  });

  it("blocks node:net named connect before a non-localhost connection starts", () => {
    expectSyncEgressBlocked(() => namedNetConnect(blockedSocketOptions));
  });

  it("blocks Socket.prototype.connect before a non-localhost connection starts", () => {
    const socket = new net.Socket();
    try {
      expect(() => socket.connect(blockedSocketOptions)).toThrowError(expect.objectContaining({
        code: "TEST_NETWORK_EGRESS_FORBIDDEN",
        message: "TEST_NETWORK_EGRESS_FORBIDDEN"
      }));
    } finally {
      socket.on("error", () => undefined);
      socket.destroy();
    }
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

  it("blocks node:http named request before a non-localhost connection starts", () => {
    expectSyncHttpEgressBlocked(() => nativeNamedExports().http.request(blockedHttpOptions));
  });

  it("blocks node:http named get before a non-localhost connection starts", () => {
    expectSyncHttpEgressBlocked(() => nativeNamedExports().http.get(blockedHttpOptions));
  });

  it("blocks node:https named request before a non-localhost connection starts", () => {
    expectSyncHttpEgressBlocked(() => nativeNamedExports().https.request(blockedHttpOptions));
  });

  it("blocks node:https named get before a non-localhost connection starts", () => {
    expectSyncHttpEgressBlocked(() => nativeNamedExports().https.get(blockedHttpOptions));
  });

  it("blocks node:tls named connect before a non-localhost connection starts", () => {
    expectSyncEgressBlocked(() => namedTlsConnect(blockedSocketOptions));
  });

  it("blocks node:tls default connect before a non-localhost connection starts", () => {
    expectSyncEgressBlocked(() => tls.connect(blockedSocketOptions));
  });
});

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { WechatCodeGateway } from "../src/infrastructure/wechat-code-gateway.js";
import {
  createMySqlCurrentUserReader,
  createSessionAuthenticator
} from "../src/plugins/authenticate.js";
import type {
  IdentityRepository,
  IdentityTransaction,
  StoredSession
} from "../src/application/identity-service.js";

const userId = "11111111-1111-4111-8111-111111111111";
const apiDirectory = fileURLToPath(new URL("../", import.meta.url));
const loginInput = {
  code: "fictional-code",
  deviceId: "fictional-device",
  consent: {
    policyVersion: "2026-08-02",
    metadataRemoval: true
  }
} as const;

describe("identity API", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it("exchanges a validated WeChat code and creates a session pair", async () => {
    const identityService = {
      login: async (input: unknown) => {
        expect(input).toEqual({
          openId: "fictional-open-id",
          deviceId: loginInput.deviceId,
          consent: loginInput.consent
        });
        return {
          accessToken: "fictional-access-token",
          accessExpiresAt: new Date("2030-01-02T05:04:05.000Z"),
          refreshToken: "fictional-refresh-token",
          refreshExpiresAt: new Date("2030-02-01T03:04:05.000Z")
        };
      }
    };
    const wechatCodeGateway = {
      exchange: async (code: string) => {
        expect(code).toBe(loginInput.code);
        return { openId: "fictional-open-id" };
      }
    };

    app = buildApp({
      identityService,
      wechatCodeGateway
    } as unknown as Parameters<typeof buildApp>[0]);
    const response = await app.inject({
      method: "POST",
      url: "/v1/identity/wechat",
      payload: loginInput
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      accessToken: "fictional-access-token",
      accessExpiresAt: "2030-01-02T05:04:05.000Z",
      refreshToken: "fictional-refresh-token",
      refreshExpiresAt: "2030-02-01T03:04:05.000Z"
    });
    expect(JSON.stringify(response.json())).not.toContain(userId);
  });

  it.each([
    { deviceId: loginInput.deviceId, consent: loginInput.consent },
    { code: loginInput.code, consent: loginInput.consent },
    {
      ...loginInput,
      consent: { ...loginInput.consent, metadataRemoval: false }
    },
    {
      ...loginInput,
      consent: { ...loginInput.consent, policyVersion: "outdated-policy" }
    },
    {
      ...loginInput,
      consent: { ...loginInput.consent, unexpected: true }
    }
  ])("rejects an invalid strict WeChat login body", async (payload) => {
    app = buildApp({
      identityService: {
        login: async () => {
          throw new Error("LOGIN_MUST_NOT_RUN");
        }
      },
      wechatCodeGateway: {
        exchange: async () => {
          throw new Error("WECHAT_EXCHANGE_MUST_NOT_RUN");
        }
      }
    } as unknown as Parameters<typeof buildApp>[0]);

    const response = await app.inject({
      method: "POST",
      url: "/v1/identity/wechat",
      payload
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: "INVALID_WECHAT_LOGIN_INPUT" });
  });

  it("rotates a session pair with the contract-required refresh token and device", async () => {
    app = buildApp({
      identityService: {
        login: async () => {
          throw new Error("LOGIN_MUST_NOT_RUN");
        },
        refresh: async (input: unknown) => {
          expect(input).toEqual({
            refreshToken: "fictional-old-refresh-token",
            deviceId: "fictional-device"
          });
          return {
            accessToken: "fictional-new-access-token",
            accessExpiresAt: new Date("2030-01-02T06:04:05.000Z"),
            refreshToken: "fictional-new-refresh-token",
            refreshExpiresAt: new Date("2030-02-01T03:04:05.000Z")
          };
        }
      },
      wechatCodeGateway: {
        exchange: async () => {
          throw new Error("WECHAT_EXCHANGE_MUST_NOT_RUN");
        }
      }
    } as unknown as Parameters<typeof buildApp>[0]);

    const response = await app.inject({
      method: "POST",
      url: "/v1/sessions/refresh",
      payload: {
        refreshToken: "fictional-old-refresh-token",
        deviceId: "fictional-device"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      accessToken: "fictional-new-access-token",
      accessExpiresAt: "2030-01-02T06:04:05.000Z",
      refreshToken: "fictional-new-refresh-token",
      refreshExpiresAt: "2030-02-01T03:04:05.000Z"
    });
  });

  it.each([
    { refreshToken: "fictional-refresh-token" },
    {
      refreshToken: "fictional-refresh-token",
      deviceId: "fictional-device",
      unexpected: true
    }
  ])("rejects an invalid strict refresh body", async (payload) => {
    app = buildApp({
      identityService: {
        login: async () => {
          throw new Error("LOGIN_MUST_NOT_RUN");
        },
        refresh: async () => {
          throw new Error("REFRESH_MUST_NOT_RUN");
        }
      },
      wechatCodeGateway: {
        exchange: async () => {
          throw new Error("WECHAT_EXCHANGE_MUST_NOT_RUN");
        }
      }
    } as unknown as Parameters<typeof buildApp>[0]);

    const response = await app.inject({
      method: "POST",
      url: "/v1/sessions/refresh",
      payload
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: "INVALID_REFRESH_INPUT" });
  });

  it.each(["SESSION_REVOKED", "SESSION_EXPIRED"])(
    "maps refresh %s to a stable unauthorized response",
    async (errorCode) => {
      app = buildApp({
        identityService: {
          login: async () => { throw new Error("LOGIN_MUST_NOT_RUN"); },
          refresh: async () => { throw new Error(errorCode); },
          logoutCurrent: async () => { throw new Error("LOGOUT_MUST_NOT_RUN"); },
          logoutAll: async () => { throw new Error("LOGOUT_MUST_NOT_RUN"); },
          requestDeletion: async () => { throw new Error("DELETION_MUST_NOT_RUN"); }
        },
        wechatCodeGateway: {
          exchange: async () => { throw new Error("EXCHANGE_MUST_NOT_RUN"); }
        }
      });

      const response = await app.inject({
        method: "POST",
        url: "/v1/sessions/refresh",
        payload: {
          refreshToken: "fictional-refresh-token",
          deviceId: "fictional-device"
        }
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ code: "UNAUTHORIZED" });
    }
  );

  it("rejects a malformed session pair instead of leaking extra output", async () => {
    app = buildApp({
      identityService: {
        login: async () => ({
          accessToken: "fictional-access-token",
          accessExpiresAt: new Date("2030-01-02T05:04:05.000Z"),
          refreshToken: "fictional-refresh-token",
          refreshExpiresAt: new Date("2030-02-01T03:04:05.000Z"),
          sensitiveExtra: "must-not-leak"
        }),
        refresh: async () => { throw new Error("REFRESH_MUST_NOT_RUN"); },
        logoutCurrent: async () => { throw new Error("LOGOUT_MUST_NOT_RUN"); },
        logoutAll: async () => { throw new Error("LOGOUT_MUST_NOT_RUN"); },
        requestDeletion: async () => { throw new Error("DELETION_MUST_NOT_RUN"); }
      },
      wechatCodeGateway: {
        exchange: async () => ({ openId: "fictional-open-id" })
      }
    } as unknown as Parameters<typeof buildApp>[0]);

    const response = await app.inject({
      method: "POST",
      url: "/v1/identity/wechat",
      payload: loginInput
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ code: "INTERNAL_ERROR" });
    expect(response.body).not.toContain("must-not-leak");
  });

  it.each([
    undefined,
    "Basic fictional-access-token",
    "Bearer",
    "bearer fictional-access-token",
    "Bearer fictional-access-token extra"
  ])("rejects a missing or malformed Bearer header", async (authorization) => {
    app = buildApp({
      identityService: {
        login: async () => { throw new Error("LOGIN_MUST_NOT_RUN"); },
        refresh: async () => { throw new Error("REFRESH_MUST_NOT_RUN"); }
      },
      wechatCodeGateway: {
        exchange: async () => { throw new Error("EXCHANGE_MUST_NOT_RUN"); }
      },
      sessionAuthenticator: {
        authenticate: async () => { throw new Error("AUTHENTICATE_MUST_NOT_RUN"); }
      },
      currentUserReader: {
        get: async () => { throw new Error("CURRENT_USER_MUST_NOT_RUN"); }
      }
    } as unknown as Parameters<typeof buildApp>[0]);

    const response = await app.inject({
      method: "GET",
      url: "/v1/me",
      ...(authorization ? { headers: { authorization } } : {})
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ code: "UNAUTHORIZED" });
  });

  it.each([
    ["fictional-unknown-token", "SESSION_REVOKED"],
    ["fictional-revoked-token", "SESSION_REVOKED"],
    ["fictional-expired-token", "SESSION_EXPIRED"]
  ])("rejects an unknown, revoked, or expired access session", async (token, errorCode) => {
    app = buildApp({
      identityService: {
        login: async () => { throw new Error("LOGIN_MUST_NOT_RUN"); },
        refresh: async () => { throw new Error("REFRESH_MUST_NOT_RUN"); }
      },
      wechatCodeGateway: {
        exchange: async () => { throw new Error("EXCHANGE_MUST_NOT_RUN"); }
      },
      sessionAuthenticator: {
        authenticate: async () => { throw new Error(errorCode); }
      },
      currentUserReader: {
        get: async () => { throw new Error("CURRENT_USER_MUST_NOT_RUN"); }
      }
    } as unknown as Parameters<typeof buildApp>[0]);

    const response = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${token}` }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ code: "UNAUTHORIZED" });
  });

  it("returns the authenticated current user without exposing session material", async () => {
    app = buildApp({
      identityService: {
        login: async () => { throw new Error("LOGIN_MUST_NOT_RUN"); },
        refresh: async () => { throw new Error("REFRESH_MUST_NOT_RUN"); }
      },
      wechatCodeGateway: {
        exchange: async () => { throw new Error("EXCHANGE_MUST_NOT_RUN"); }
      },
      sessionAuthenticator: {
        authenticate: async (accessToken: string) => {
          expect(accessToken).toBe("fictional-access-token");
          return {
            userId,
            sessionId: "must-not-leak",
            accessToken: "must-not-leak"
          };
        }
      },
      currentUserReader: {
        get: async (authenticatedUserId: string) => {
          expect(authenticatedUserId).toBe(userId);
          return {
            userId,
            status: "ACTIVE" as const,
            activeDeviceCount: 2
          };
        }
      }
    } as unknown as Parameters<typeof buildApp>[0]);

    const response = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: "Bearer fictional-access-token" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      userId,
      status: "ACTIVE",
      activeDeviceCount: 2
    });
    expect(JSON.stringify(response.json())).not.toContain("must-not-leak");
  });

  it("never returns a current-user record for a different authenticated user", async () => {
    app = buildApp({
      identityService: {
        login: async () => { throw new Error("LOGIN_MUST_NOT_RUN"); },
        refresh: async () => { throw new Error("REFRESH_MUST_NOT_RUN"); }
      },
      wechatCodeGateway: {
        exchange: async () => { throw new Error("EXCHANGE_MUST_NOT_RUN"); }
      },
      sessionAuthenticator: {
        authenticate: async () => ({ userId })
      },
      currentUserReader: {
        get: async () => ({
          userId: "22222222-2222-4222-8222-222222222222",
          status: "ACTIVE" as const,
          activeDeviceCount: 1
        })
      }
    } as unknown as Parameters<typeof buildApp>[0]);

    const response = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: "Bearer fictional-access-token" }
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ code: "INTERNAL_ERROR" });
    expect(response.body).not.toContain("22222222-2222-4222-8222-222222222222");
  });

  it.each([
    ["CURRENT_USER_NOT_FOUND", 401, "UNAUTHORIZED"],
    ["DATABASE_UNAVAILABLE", 500, "INTERNAL_ERROR"]
  ] as const)(
    "maps current-user reader error %s to a stable %s response",
    async (readerError, expectedStatus, expectedCode) => {
      app = buildApp({
        identityService: {
          login: async () => { throw new Error("LOGIN_MUST_NOT_RUN"); },
          refresh: async () => { throw new Error("REFRESH_MUST_NOT_RUN"); }
        },
        wechatCodeGateway: {
          exchange: async () => { throw new Error("EXCHANGE_MUST_NOT_RUN"); }
        },
        sessionAuthenticator: {
          authenticate: async () => ({ userId })
        },
        currentUserReader: {
          get: async () => { throw new Error(readerError); }
        }
      } as unknown as Parameters<typeof buildApp>[0]);

      const response = await app.inject({
        method: "GET",
        url: "/v1/me",
        headers: { authorization: "Bearer fictional-access-token" }
      });

      expect(response.statusCode).toBe(expectedStatus);
      expect(response.json()).toEqual({ code: expectedCode });
    }
  );

  it.each([
    ["DELETE", "/v1/sessions/current", "logoutCurrent"],
    ["DELETE", "/v1/sessions", "logoutAll"],
    ["POST", "/v1/account/deletion", "requestDeletion"]
  ] as const)(
    "handles an authenticated %s %s without exposing the Bearer token",
    async (method, url, expectedOperation) => {
      const operation = async (name: string, accessToken: string) => {
        if (name !== expectedOperation || accessToken !== "fictional-access-token") {
          throw new Error("WRONG_IDENTITY_OPERATION");
        }
      };
      app = buildApp({
        identityService: {
          login: async () => { throw new Error("LOGIN_MUST_NOT_RUN"); },
          refresh: async () => { throw new Error("REFRESH_MUST_NOT_RUN"); },
          logoutCurrent: async (token: string) => operation("logoutCurrent", token),
          logoutAll: async (token: string) => operation("logoutAll", token),
          requestDeletion: async (token: string) => operation("requestDeletion", token)
        },
        wechatCodeGateway: {
          exchange: async () => { throw new Error("EXCHANGE_MUST_NOT_RUN"); }
        },
        sessionAuthenticator: {
          authenticate: async () => ({ userId })
        }
      } as unknown as Parameters<typeof buildApp>[0]);

      const response = await app.inject({
        method,
        url,
        headers: { authorization: "Bearer fictional-access-token" }
      });

      expect(response.statusCode).toBe(204);
      expect(response.body).toBe("");
    }
  );

  it.each([
    ["DELETE", "/v1/sessions/current", "logoutCurrent"],
    ["DELETE", "/v1/sessions", "logoutAll"],
    ["POST", "/v1/account/deletion", "requestDeletion"]
  ] as const)(
    "maps a post-authentication %s %s session race to unauthorized",
    async (method, url, failingOperation) => {
      const operation = async (name: string) => {
        if (name === failingOperation) {
          throw new Error("SESSION_REVOKED");
        }
        throw new Error("WRONG_IDENTITY_OPERATION");
      };
      app = buildApp({
        identityService: {
          login: async () => { throw new Error("LOGIN_MUST_NOT_RUN"); },
          refresh: async () => { throw new Error("REFRESH_MUST_NOT_RUN"); },
          logoutCurrent: async () => operation("logoutCurrent"),
          logoutAll: async () => operation("logoutAll"),
          requestDeletion: async () => operation("requestDeletion")
        },
        wechatCodeGateway: {
          exchange: async () => { throw new Error("EXCHANGE_MUST_NOT_RUN"); }
        },
        sessionAuthenticator: {
          authenticate: async () => ({ userId })
        }
      });

      const response = await app.inject({
        method,
        url,
        headers: { authorization: "Bearer fictional-racing-access-token" }
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ code: "UNAUTHORIZED" });
    }
  );
});

describe("health API", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it("reports process liveness without probing dependencies", async () => {
    app = buildApp();

    const response = await app.inject({ method: "GET", url: "/health/live" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "live" });
  });

  it("reports readiness only after the injected dependency check succeeds", async () => {
    app = buildApp({
      readiness: { check: async () => undefined }
    } as unknown as Parameters<typeof buildApp>[0]);

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ready" });
  });

  it("reports a stable not-ready response without leaking dependency errors", async () => {
    const sensitiveDependencyError = "mysql://fictional-user:fictional-password@db/app";
    app = buildApp({
      readiness: {
        check: async () => { throw new Error(sensitiveDependencyError); }
      }
    } as unknown as Parameters<typeof buildApp>[0]);

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "not_ready" });
    expect(response.body).not.toContain(sensitiveDependencyError);
  });
});

describe("production session authentication", () => {
  let app: FastifyInstance | undefined;
  const now = new Date("2030-01-02T03:04:05.000Z");

  afterEach(async () => {
    await app?.close();
  });

  it("authenticates a live repository session by access digest", async () => {
    const accessToken = "fictional-repository-access-token";
    const session = storedAccessSession({
      accessExpiresAt: new Date(now.getTime() + 60_000),
      revokedAt: null
    });
    const authenticator = createSessionAuthenticator(
      repositoryReturning(session, accessToken),
      { now: () => new Date(now) }
    );
    app = buildAuthenticatedMeApp(authenticator);

    const response = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${accessToken}` }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      userId,
      status: "ACTIVE",
      activeDeviceCount: 1
    });
  });

  it.each([
    ["unknown", undefined],
    ["revoked", storedAccessSession({
      accessExpiresAt: new Date(now.getTime() + 60_000),
      revokedAt: new Date(now.getTime() - 1)
    })],
    ["expired", storedAccessSession({
      accessExpiresAt: new Date(now),
      revokedAt: null
    })]
  ] as const)("rejects a repository %s access session", async (_kind, session) => {
    const accessToken = `fictional-${_kind}-repository-token`;
    const authenticator = createSessionAuthenticator(
      repositoryReturning(session, accessToken),
      { now: () => new Date(now) }
    );
    app = buildAuthenticatedMeApp(authenticator);

    const response = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: `Bearer ${accessToken}` }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ code: "UNAUTHORIZED" });
  });

  it("counts devices with live refresh sessions even after access expiry", async () => {
    const reader = createMySqlCurrentUserReader({
      execute: async (sql: string, values?: unknown[]) => {
        expect(values).toEqual([userId, now]);
        return [[{
          user_id: userId,
          status: "DELETING",
          active_device_count: sql.includes("s.refresh_expires_at > ?") ? 2 : 0
        }], []] as never;
      }
    }, { now: () => new Date(now) });
    app = buildApp({
      identityService: {
        login: async () => { throw new Error("LOGIN_MUST_NOT_RUN"); },
        refresh: async () => { throw new Error("REFRESH_MUST_NOT_RUN"); },
        logoutCurrent: async () => { throw new Error("LOGOUT_MUST_NOT_RUN"); },
        logoutAll: async () => { throw new Error("LOGOUT_MUST_NOT_RUN"); },
        requestDeletion: async () => { throw new Error("DELETION_MUST_NOT_RUN"); }
      },
      wechatCodeGateway: {
        exchange: async () => { throw new Error("EXCHANGE_MUST_NOT_RUN"); }
      },
      sessionAuthenticator: {
        authenticate: async () => ({ userId })
      },
      currentUserReader: reader
    });

    const response = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { authorization: "Bearer fictional-reader-access-token" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      userId,
      status: "DELETING",
      activeDeviceCount: 2
    });
  });
});

describe("production server assembly", () => {
  it("can be imported without starting a listener or connecting externally", async () => {
    const probe = await runServerImportProbe();

    expect(probe).toEqual({
      timedOut: false,
      exitCode: 0,
      stdout: "IMPORT_OK"
    });
  });

  it("listens on the loaded host and port with a live production assembly", async () => {
    const probe = await runLiveServerProbe();

    expect(probe).toEqual({
      statusCode: 200,
      body: { status: "live" }
    });
  });
});

describe("WechatCodeGateway", () => {
  const config = {
    wechatAppId: "wx-fictional-app-id",
    wechatAppSecret: "fictional-app-secret"
  };

  it("exchanges a fictional code using the bounded jscode2session request", async () => {
    let requestedUrl: URL | undefined;
    let requestedSignal: AbortSignal | null | undefined;
    const gateway = new WechatCodeGateway(config, async (input, init) => {
      requestedUrl = new URL(String(input));
      requestedSignal = init?.signal;
      return new Response(JSON.stringify({
        openid: "fictional-open-id",
        unionid: "fictional-union-id",
        session_key: "fictional-session-key"
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }, 100);

    await expect(gateway.exchange("fictional-code")).resolves.toEqual({
      openId: "fictional-open-id",
      unionId: "fictional-union-id"
    });
    expect(requestedUrl?.origin).toBe("https://api.weixin.qq.com");
    expect(requestedUrl?.pathname).toBe("/sns/jscode2session");
    expect(Object.fromEntries(requestedUrl?.searchParams ?? [])).toEqual({
      appid: "wx-fictional-app-id",
      secret: "fictional-app-secret",
      js_code: "fictional-code",
      grant_type: "authorization_code"
    });
    expect(requestedSignal).toBeInstanceOf(AbortSignal);
  });

  it("maps an aborted request to a stable timeout code", async () => {
    const gateway = new WechatCodeGateway(config, async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error("TEST_SIGNAL_MISSING"));
          return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }), 1);

    await expect(gateway.exchange("fictional-timeout-code"))
      .rejects.toThrow("WECHAT_TIMEOUT");
  });

  it("maps an abort while parsing the response body to a stable timeout code", async () => {
    const gateway = new WechatCodeGateway(config, async () => ({
      ok: true,
      json: async () => {
        const error = new Error("fictional-sensitive-body-abort");
        error.name = "AbortError";
        throw error;
      }
    } as unknown as Response));

    await expect(rejectedMessage(gateway.exchange("fictional-body-timeout-code")))
      .resolves.toBe("WECHAT_TIMEOUT");
  });

  it("maps an already-aborted response signal to a stable timeout code", async () => {
    const gateway = new WechatCodeGateway(config, async (_input, init) => ({
      ok: true,
      json: async () => {
        const signal = init?.signal;
        if (!signal) {
          throw new Error("TEST_SIGNAL_MISSING");
        }
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new SyntaxError("fictional-sensitive-malformed-body");
      }
    } as unknown as Response), 1);

    await expect(rejectedMessage(gateway.exchange("fictional-aborted-body-code")))
      .resolves.toBe("WECHAT_TIMEOUT");
  });

  it("maps a valid JSON null body to a stable invalid-response code", async () => {
    const gateway = new WechatCodeGateway(config, async () =>
      new Response("null", {
        status: 200,
        headers: { "content-type": "application/json" }
      }));

    await expect(rejectedMessage(gateway.exchange("fictional-null-body-code")))
      .resolves.toBe("WECHAT_INVALID_RESPONSE");
  });

  it("maps a network failure without retaining sensitive exception text", async () => {
    const sensitiveText = [
      "fictional-network-code",
      config.wechatAppSecret,
      "fictional-network-open-id",
      "fictional-wechat-response-body"
    ];
    const gateway = new WechatCodeGateway(config, async () => {
      throw new TypeError(sensitiveText.join("|"));
    });

    const message = await rejectedMessage(gateway.exchange(sensitiveText[0]!));

    expect(message).toBe("WECHAT_NETWORK_ERROR");
    for (const sensitive of sensitiveText) {
      expect(message).not.toContain(sensitive);
    }
  });

  it("maps a non-success HTTP response without parsing or exposing its body", async () => {
    const sensitiveBody = "fictional-http-open-id fictional-http-errmsg";
    const gateway = new WechatCodeGateway(config, async () =>
      new Response(sensitiveBody, { status: 502 }));

    const message = await rejectedMessage(gateway.exchange("fictional-http-code"));

    expect(message).toBe("WECHAT_UNAVAILABLE");
    expect(message).not.toContain(sensitiveBody);
  });

  it.each([
    [40029, "WECHAT_CODE_REJECTED"],
    [40163, "WECHAT_CODE_REJECTED"],
    [45011, "WECHAT_RATE_LIMITED"],
    [-1, "WECHAT_UNAVAILABLE"],
    [987654, "WECHAT_REQUEST_FAILED"]
  ])("maps WeChat business error %s to a stable internal code", async (errcode, expected) => {
    const gateway = new WechatCodeGateway(config, async () =>
      new Response(JSON.stringify({
        errcode,
        errmsg: "fictional-sensitive-errmsg",
        openid: "fictional-error-open-id"
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }));

    const message = await rejectedMessage(
      gateway.exchange(`fictional-business-code-${errcode}`)
    );

    expect(message).toBe(expected);
    expect(message).not.toContain(String(errcode));
    expect(message).not.toContain("fictional-sensitive-errmsg");
    expect(message).not.toContain("fictional-error-open-id");
  });
});

describe("WeChat login error responses", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it.each([
    ["WECHAT_CODE_REJECTED", 401],
    ["WECHAT_RATE_LIMITED", 429],
    ["WECHAT_TIMEOUT", 503],
    ["WECHAT_NETWORK_ERROR", 503],
    ["WECHAT_UNAVAILABLE", 503],
    ["WECHAT_REQUEST_FAILED", 502],
    ["WECHAT_INVALID_RESPONSE", 502]
  ])("returns stable %s without a framework error envelope", async (code, statusCode) => {
    app = buildApp({
      identityService: {
        login: async () => { throw new Error("LOGIN_MUST_NOT_RUN"); },
        refresh: async () => { throw new Error("REFRESH_MUST_NOT_RUN"); },
        logoutCurrent: async () => { throw new Error("LOGOUT_MUST_NOT_RUN"); },
        logoutAll: async () => { throw new Error("LOGOUT_MUST_NOT_RUN"); },
        requestDeletion: async () => { throw new Error("DELETION_MUST_NOT_RUN"); }
      },
      wechatCodeGateway: {
        exchange: async () => { throw new Error(code); }
      }
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/identity/wechat",
      payload: loginInput
    });

    expect(response.statusCode).toBe(statusCode);
    expect(response.json()).toEqual({ code });
  });

  it("keeps code, AppSecret, OpenID, and WeChat body out of response and captured logs", async () => {
    const sensitive = {
      code: "fictional-sensitive-code",
      appSecret: "fictional-sensitive-app-secret",
      openId: "fictional-sensitive-open-id",
      responseBody: "fictional-sensitive-wechat-body"
    };
    let capturedLogs = "";
    const gateway = new WechatCodeGateway({
      wechatAppId: "wx-fictional-app-id",
      wechatAppSecret: sensitive.appSecret
    }, async () => new Response(JSON.stringify({
      openid: sensitive.openId,
      errmsg: sensitive.responseBody
    }), { status: 502 }));
    app = buildApp({
      logger: {
        level: "info",
        stream: {
          write(line: string) { capturedLogs += line; }
        }
      },
      identityService: {
        login: async () => { throw new Error("LOGIN_MUST_NOT_RUN"); },
        refresh: async () => { throw new Error("REFRESH_MUST_NOT_RUN"); },
        logoutCurrent: async () => { throw new Error("LOGOUT_MUST_NOT_RUN"); },
        logoutAll: async () => { throw new Error("LOGOUT_MUST_NOT_RUN"); },
        requestDeletion: async () => { throw new Error("DELETION_MUST_NOT_RUN"); }
      },
      wechatCodeGateway: gateway
    } as unknown as Parameters<typeof buildApp>[0]);

    const response = await app.inject({
      method: "POST",
      url: "/v1/identity/wechat",
      payload: { ...loginInput, code: sensitive.code }
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ code: "WECHAT_UNAVAILABLE" });
    expect(capturedLogs).toContain("request completed");
    for (const value of Object.values(sensitive)) {
      expect(response.body).not.toContain(value);
      expect(capturedLogs).not.toContain(value);
    }
  });
});

function storedAccessSession(
  overrides: Pick<StoredSession, "accessExpiresAt" | "revokedAt">
): StoredSession {
  return {
    id: "fictional-session-id",
    userId,
    deviceIdHash: Buffer.alloc(32, 0x11),
    accessTokenHash: Buffer.alloc(32, 0x22),
    accessExpiresAt: overrides.accessExpiresAt,
    refreshTokenHash: Buffer.alloc(32, 0x33),
    refreshExpiresAt: new Date("2030-02-01T03:04:05.000Z"),
    lastUsedAt: new Date("2030-01-02T03:04:05.000Z"),
    revokedAt: overrides.revokedAt
  };
}

function repositoryReturning(
  session: StoredSession | undefined,
  accessToken: string
): IdentityRepository {
  return {
    transaction: async <T>(work: (tx: IdentityTransaction) => Promise<T>) =>
      work({
        findSessionByAccessHashForUpdate: async (accessTokenHash: Buffer) => {
          expect(accessTokenHash).toEqual(
            createHash("sha256").update(accessToken).digest()
          );
          return session;
        }
      } as IdentityTransaction)
  };
}

function buildAuthenticatedMeApp(sessionAuthenticator: {
  authenticate(accessToken: string): Promise<{ userId: string }>;
}): FastifyInstance {
  return buildApp({
    identityService: {
      login: async () => { throw new Error("LOGIN_MUST_NOT_RUN"); },
      refresh: async () => { throw new Error("REFRESH_MUST_NOT_RUN"); },
      logoutCurrent: async () => { throw new Error("LOGOUT_MUST_NOT_RUN"); },
      logoutAll: async () => { throw new Error("LOGOUT_MUST_NOT_RUN"); },
      requestDeletion: async () => { throw new Error("DELETION_MUST_NOT_RUN"); }
    },
    wechatCodeGateway: {
      exchange: async () => { throw new Error("EXCHANGE_MUST_NOT_RUN"); }
    },
    sessionAuthenticator,
    currentUserReader: {
      get: async (authenticatedUserId: string) => ({
        userId: authenticatedUserId,
        status: "ACTIVE",
        activeDeviceCount: 1
      })
    }
  });
}

async function runServerImportProbe(): Promise<{
  timedOut: boolean;
  exitCode: number | null;
  stdout: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--import",
      "tsx",
      "--eval",
      "import('./src/server.ts').then(() => console.log('IMPORT_OK'))"
    ], {
      cwd: apiDirectory,
      env: {
        ...process.env,
        NODE_ENV: "",
        PORT: "",
        MYSQL_URL: "",
        WECHAT_APP_ID: "",
        WECHAT_APP_SECRET: "",
        IDENTITY_LOOKUP_KEY: "",
        IDENTITY_ENCRYPTION_KEY: ""
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const timeout = setTimeout(() => {
      child.kill();
      resolve({ timedOut: true, exitCode: null, stdout: stdout.trim() });
    }, 5_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (exitCode) => {
      clearTimeout(timeout);
      if (stderr.trim()) {
        stdout += `\nSTDERR:${stderr.trim()}`;
      }
      resolve({ timedOut: false, exitCode, stdout: stdout.trim() });
    });
  });
}

async function runLiveServerProbe(): Promise<{
  statusCode: number | null;
  body: unknown;
}> {
  const port = await availablePort();
  const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: apiDirectory,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      MYSQL_URL: "mysql://fictional-user:fictional-password@127.0.0.1/fictional-db",
      WECHAT_APP_ID: "wx4f7678cc595d276b",
      WECHAT_APP_SECRET: "fictional-runtime-app-secret",
      IDENTITY_LOOKUP_KEY: "11".repeat(32),
      IDENTITY_ENCRYPTION_KEY: "22".repeat(32)
    },
    stdio: "ignore"
  });
  const deadline = Date.now() + 2_000;
  try {
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        break;
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health/live`);
        return { statusCode: response.status, body: await response.json() };
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    return { statusCode: null, body: null };
  } finally {
    child.kill();
  }
}

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("TEST_PORT_UNAVAILABLE"));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function rejectedMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    throw new Error("TEST_EXPECTED_REJECTION");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

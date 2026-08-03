import {
  CurrentUserSchema,
  RefreshInputSchema,
  SessionPairSchema,
  WechatLoginInputSchema,
  type CurrentUser
} from "@photo-ai/contracts";
import type {
  FastifyInstance,
  FastifyRequest,
  preHandlerHookHandler
} from "fastify";
import type { IdentityService } from "../application/identity-service.js";

export type IdentityApiService = Pick<
  IdentityService,
  "login" | "refresh" | "logoutCurrent" | "logoutAll" | "requestDeletion"
>;

export interface WechatCodeGateway {
  exchange(code: string): Promise<{ openId: string; unionId?: string }>;
}

export interface IdentityRouteDependencies {
  identityService: IdentityApiService;
  wechatCodeGateway: WechatCodeGateway;
  authenticate?: preHandlerHookHandler;
  currentUserReader?: CurrentUserReader;
}

export interface CurrentUserReader {
  get(userId: string): Promise<CurrentUser>;
}

export async function registerIdentityRoutes(
  app: FastifyInstance,
  dependencies: IdentityRouteDependencies
): Promise<void> {
  app.post("/v1/identity/wechat", async (request, reply) => {
    const parsed = WechatLoginInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: "INVALID_WECHAT_LOGIN_INPUT" });
    }
    const input = parsed.data;
    try {
      const { openId } = await dependencies.wechatCodeGateway.exchange(input.code);
      const pair = await dependencies.identityService.login({
        openId,
        deviceId: input.deviceId,
        consent: input.consent
      });

      return reply.code(201).send(normalizeSessionPair(pair));
    } catch (error) {
      return sendIdentityError(reply, error);
    }
  });

  app.post("/v1/sessions/refresh", async (request, reply) => {
    const parsed = RefreshInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: "INVALID_REFRESH_INPUT" });
    }
    try {
      return reply.send(normalizeSessionPair(
        await dependencies.identityService.refresh(parsed.data)
      ));
    } catch (error) {
      return sendIdentityError(reply, error);
    }
  });

  if (dependencies.authenticate && dependencies.currentUserReader) {
    app.get("/v1/me", {
      preHandler: dependencies.authenticate
    }, async (request, reply) => {
      try {
        const currentUser = CurrentUserSchema.parse(
          await dependencies.currentUserReader!.get(request.auth.userId)
        );
        if (currentUser.userId !== request.auth.userId) {
          return reply.code(500).send({ code: "INTERNAL_ERROR" });
        }
        return reply.send(currentUser);
      } catch {
        return reply.code(500).send({ code: "INTERNAL_ERROR" });
      }
    });
  }

  if (dependencies.authenticate) {
    app.delete("/v1/sessions/current", {
      preHandler: dependencies.authenticate
    }, async (request, reply) => {
      try {
        await dependencies.identityService.logoutCurrent(bearerToken(request));
        return reply.code(204).send();
      } catch (error) {
        return sendIdentityError(reply, error);
      }
    });

    app.delete("/v1/sessions", {
      preHandler: dependencies.authenticate
    }, async (request, reply) => {
      try {
        await dependencies.identityService.logoutAll(bearerToken(request));
        return reply.code(204).send();
      } catch (error) {
        return sendIdentityError(reply, error);
      }
    });

    app.post("/v1/account/deletion", {
      preHandler: dependencies.authenticate
    }, async (request, reply) => {
      try {
        await dependencies.identityService.requestDeletion(bearerToken(request));
        return reply.code(204).send();
      } catch (error) {
        return sendIdentityError(reply, error);
      }
    });
  }
}

function bearerToken(request: FastifyRequest): string {
  return request.headers.authorization!.slice("Bearer ".length);
}

function sendIdentityError(reply: { code(statusCode: number): { send(body: unknown): unknown } }, error: unknown) {
  const code = error instanceof Error ? error.message : "INTERNAL_ERROR";
  if (code === "SESSION_REVOKED" || code === "SESSION_EXPIRED") {
    return reply.code(401).send({ code: "UNAUTHORIZED" });
  }
  if (code === "WECHAT_CODE_REJECTED") {
    return reply.code(401).send({ code });
  }
  if (code === "WECHAT_RATE_LIMITED") {
    return reply.code(429).send({ code });
  }
  if (["WECHAT_TIMEOUT", "WECHAT_NETWORK_ERROR", "WECHAT_UNAVAILABLE"].includes(code)) {
    return reply.code(503).send({ code });
  }
  if (["WECHAT_REQUEST_FAILED", "WECHAT_INVALID_RESPONSE"].includes(code)) {
    return reply.code(502).send({ code });
  }
  return reply.code(500).send({ code: "INTERNAL_ERROR" });
}

function normalizeSessionPair(pair: unknown) {
  const parsed = SessionPairSchema.safeParse(JSON.parse(JSON.stringify(pair)));
  if (!parsed.success) {
    throw new Error("INVALID_SESSION_OUTPUT");
  }
  return parsed.data;
}

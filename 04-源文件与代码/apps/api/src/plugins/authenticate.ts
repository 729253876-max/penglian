import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler
} from "fastify";
import type { IdentityRepository } from "../application/identity-service.js";
import { systemClock, type Clock } from "../domain/clock.js";
import { digestToken } from "../domain/session-token.js";

declare module "fastify" {
  interface FastifyRequest {
    auth: { userId: string };
  }
}

export interface SessionAuthenticator {
  authenticate(accessToken: string): Promise<{ userId: string }>;
}

interface CurrentUserRow {
  user_id: string;
  status: "ACTIVE" | "DELETING" | "DELETED";
  active_device_count: number | string;
}

export interface CurrentUserDatabase {
  execute(
    sql: string,
    values: unknown[]
  ): Promise<[CurrentUserRow[], unknown]>;
}

export function createMySqlCurrentUserReader(
  database: CurrentUserDatabase,
  clock: Clock = systemClock
) {
  return {
    get: async (userId: string) => {
      const now = clock.now();
      const [rows] = await database.execute(
        `SELECT u.id AS user_id, u.status,
                COUNT(DISTINCT s.device_id_hash) AS active_device_count
         FROM users u
         INNER JOIN sessions s ON s.user_id = u.id
         WHERE u.id = ?
           AND u.status IN ('ACTIVE', 'DELETING')
           AND s.revoked_at IS NULL
           AND s.access_expires_at > ?
         GROUP BY u.id, u.status
         LIMIT 1`,
        [userId, now]
      );
      const row = rows[0];
      if (!row || row.status === "DELETED") {
        throw new Error("CURRENT_USER_NOT_FOUND");
      }
      return {
        userId: row.user_id,
        status: row.status,
        activeDeviceCount: Number(row.active_device_count)
      };
    }
  };
}

export function createSessionAuthenticator(
  repository: IdentityRepository,
  clock: Clock = systemClock
): SessionAuthenticator {
  return {
    authenticate: async (accessToken) => {
      const digest = digestToken(accessToken);
      const now = clock.now();
      return repository.transaction(async (tx) => {
        const session = await tx.findSessionByAccessHashForUpdate(digest);
        if (!session || session.revokedAt !== null) {
          throw new Error("SESSION_REVOKED");
        }
        if (session.accessExpiresAt.getTime() <= now.getTime()) {
          throw new Error("SESSION_EXPIRED");
        }
        return { userId: session.userId };
      });
    }
  };
}

function isAuthenticationError(error: unknown): boolean {
  return error instanceof Error && [
    "UNAUTHORIZED",
    "SESSION_REVOKED",
    "SESSION_EXPIRED"
  ].includes(error.message);
}

export function installAuthentication(
  app: FastifyInstance,
  authenticator: SessionAuthenticator
): preHandlerHookHandler {
  app.decorateRequest("auth");

  return async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    const authorization = request.headers.authorization;
    const match = typeof authorization === "string"
      ? /^Bearer ([^\s]+)$/.exec(authorization)
      : null;
    if (!match) {
      await reply.code(401).send({ code: "UNAUTHORIZED" });
      return;
    }

    try {
      const authenticated = await authenticator.authenticate(match[1]!);
      request.auth = { userId: authenticated.userId };
    } catch (error) {
      if (!isAuthenticationError(error)) {
        throw error;
      }
      await reply.code(401).send({ code: "UNAUTHORIZED" });
    }
  };
}

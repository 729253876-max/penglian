import Fastify, { type FastifyServerOptions } from "fastify";
import { TaskService } from "./application/task-service.js";
import { InMemoryTaskRepository } from "./infrastructure/in-memory-task-repository.js";
import { MockImageProvider } from "./infrastructure/mock-image-provider.js";
import {
  installAuthentication,
  type SessionAuthenticator
} from "./plugins/authenticate.js";
import {
  registerIdentityRoutes,
  type CurrentUserReader,
  type IdentityApiService,
  type WechatCodeGateway
} from "./routes/identity.js";
import { registerTaskRoutes, type TaskApiService } from "./routes/tasks.js";

export interface BuildAppOptions {
  logger?: FastifyServerOptions["logger"];
  service?: TaskApiService;
  identityService?: IdentityApiService;
  wechatCodeGateway?: WechatCodeGateway;
  sessionAuthenticator?: SessionAuthenticator;
  currentUserReader?: CurrentUserReader;
  readiness?: Readiness;
}

export interface Readiness {
  check(): Promise<void>;
}

export function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({ logger: options.logger ?? false });
  const service = options.service ?? new TaskService(
    new InMemoryTaskRepository(),
    new MockImageProvider()
  );
  const authenticate = options.sessionAuthenticator
    ? installAuthentication(app, options.sessionAuthenticator)
    : undefined;

  app.register(registerTaskRoutes, service);
  app.get("/health/live", async () => ({ status: "live" }));
  app.get("/health/ready", async (_request, reply) => {
    if (!options.readiness) {
      return reply.code(503).send({ status: "not_ready" });
    }
    try {
      await options.readiness.check();
      return reply.send({ status: "ready" });
    } catch {
      return reply.code(503).send({ status: "not_ready" });
    }
  });
  if (options.identityService && options.wechatCodeGateway) {
    app.register(registerIdentityRoutes, {
      identityService: options.identityService,
      wechatCodeGateway: options.wechatCodeGateway,
      ...(authenticate ? { authenticate } : {}),
      ...(options.currentUserReader
        ? { currentUserReader: options.currentUserReader }
        : {})
    });
  }
  return app;
}

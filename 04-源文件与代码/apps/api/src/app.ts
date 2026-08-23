import Fastify, {
  type FastifyServerOptions,
  type preHandlerHookHandler
} from "fastify";
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
import { registerUploadRoutes, type UploadApiService } from "./routes/uploads.js";

export interface BuildAppOptions {
  logger?: FastifyServerOptions["logger"];
  service?: TaskApiService;
  identityService?: IdentityApiService;
  wechatCodeGateway?: WechatCodeGateway;
  sessionAuthenticator?: SessionAuthenticator;
  currentUserReader?: CurrentUserReader;
  readiness?: Readiness;
  uploadService?: UploadApiService;
}

export interface Readiness {
  check(): Promise<void>;
}

export function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({ logger: options.logger ?? false });
  const service = options.service ?? unavailableTaskService;
  const authenticate = options.sessionAuthenticator
    ? installAuthentication(app, options.sessionAuthenticator)
    : undefined;
  const requireTaskAuthentication: preHandlerHookHandler = authenticate ??
    (async (_request, reply) => {
      await reply.code(401).send({ code: "UNAUTHORIZED" });
    });

  app.register(registerTaskRoutes, {
    service,
    authenticate: requireTaskAuthentication
  });
  if (options.uploadService) {
    app.register(registerUploadRoutes, {
      service: options.uploadService,
      authenticate: requireTaskAuthentication
    });
  }
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

const unavailableTaskService: TaskApiService = {
  create: async () => {
    throw new Error("TASK_SERVICE_NOT_CONFIGURED");
  },
  confirmAndRunPreview: async () => {
    throw new Error("TASK_SERVICE_NOT_CONFIGURED");
  },
  get: async () => {
    throw new Error("TASK_SERVICE_NOT_CONFIGURED");
  },
  getEvents: async () => {
    throw new Error("TASK_SERVICE_NOT_CONFIGURED");
  }
};

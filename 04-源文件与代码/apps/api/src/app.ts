import Fastify from "fastify";
import { TaskService } from "./application/task-service.js";
import { InMemoryTaskRepository } from "./infrastructure/in-memory-task-repository.js";
import { MockImageProvider } from "./infrastructure/mock-image-provider.js";
import { registerTaskRoutes, type TaskApiService } from "./routes/tasks.js";

export interface BuildAppOptions {
  service?: TaskApiService;
}

export function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({ logger: false });
  const service = options.service ?? new TaskService(
    new InMemoryTaskRepository(),
    new MockImageProvider()
  );

  app.register(registerTaskRoutes, service);
  return app;
}

import { pathToFileURL } from "node:url";
import { createPool, type Pool } from "mysql2/promise";
import { buildApp } from "./app.js";
import { IdentityService } from "./application/identity-service.js";
import { loadConfig, type ApiConfig } from "./config.js";
import { MySqlIdentityRepository } from "./infrastructure/mysql-identity-repository.js";
import { WechatCodeGateway } from "./infrastructure/wechat-code-gateway.js";
import {
  createMySqlCurrentUserReader,
  createSessionAuthenticator,
  type CurrentUserDatabase
} from "./plugins/authenticate.js";

export interface ProductionAppDependencies {
  pool?: Pool;
  fetcher?: typeof fetch;
}

export function buildProductionApp(
  config: ApiConfig,
  dependencies: ProductionAppDependencies = {}
) {
  const ownsPool = dependencies.pool === undefined;
  const pool = dependencies.pool ?? createPool(config.mysqlUrl);
  const repository = new MySqlIdentityRepository(pool);
  const app = buildApp({
    logger: config.nodeEnv === "test" ? false : true,
    identityService: new IdentityService(repository, config),
    wechatCodeGateway: new WechatCodeGateway(config, dependencies.fetcher),
    sessionAuthenticator: createSessionAuthenticator(repository),
    currentUserReader: createMySqlCurrentUserReader(
      pool as unknown as CurrentUserDatabase
    ),
    readiness: {
      check: async () => {
        await pool.query("SELECT 1");
      }
    }
  });

  if (ownsPool) {
    app.addHook("onClose", async () => {
      await pool.end();
    });
  }
  return app;
}

export async function startServer(
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const config = loadConfig(env);
  const app = buildProductionApp(config);

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch {
    await app.close();
    throw new Error("SERVER_START_FAILED");
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void startServer().catch(() => {
    console.error("SERVER_START_FAILED");
    process.exitCode = 1;
  });
}

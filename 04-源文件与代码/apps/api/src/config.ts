export interface ApiConfig {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  mysqlUrl: string;
  wechatAppId: string;
  wechatAppSecret: string;
  identityLookupKey: Buffer;
  identityEncryptionKey: Buffer;
}

type ConfigEnvironment = Record<string, string | undefined>;

const nodeEnvironments = new Set<ApiConfig["nodeEnv"]>([
  "development",
  "test",
  "production"
]);
const productionWechatAppId = "wx4f7678cc595d276b";
const keyPattern = /^[a-f0-9]{64}$/i;

function invalid(code: string): never {
  throw new Error(code);
}

function required(env: ConfigEnvironment, name: string): string {
  const value = env[name];
  if (!value) {
    invalid(`MISSING_${name}`);
  }
  return value;
}

function loadIdentityKey(env: ConfigEnvironment, name: string): Buffer {
  const value = required(env, name);
  if (!keyPattern.test(value)) {
    invalid(`INVALID_${name}`);
  }
  return Buffer.from(value, "hex");
}

export function loadConfig(env: ConfigEnvironment): ApiConfig {
  const nodeEnv = required(env, "NODE_ENV");
  if (!nodeEnvironments.has(nodeEnv as ApiConfig["nodeEnv"])) {
    invalid("INVALID_NODE_ENV");
  }

  const portValue = required(env, "PORT");
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    invalid("INVALID_PORT");
  }

  const mysqlUrl = required(env, "MYSQL_URL");
  try {
    const parsed = new URL(mysqlUrl);
    if (parsed.protocol !== "mysql:" || !parsed.hostname) {
      invalid("INVALID_MYSQL_URL");
    }
  } catch {
    invalid("INVALID_MYSQL_URL");
  }

  const wechatAppId = required(env, "WECHAT_APP_ID");
  if (wechatAppId !== productionWechatAppId) {
    invalid("INVALID_WECHAT_APP_ID");
  }

  const identityLookupKey = loadIdentityKey(env, "IDENTITY_LOOKUP_KEY");
  const identityEncryptionKey = loadIdentityKey(env, "IDENTITY_ENCRYPTION_KEY");
  if (identityLookupKey.equals(identityEncryptionKey)) {
    invalid("IDENTITY_KEYS_MUST_DIFFER");
  }

  return {
    nodeEnv: nodeEnv as ApiConfig["nodeEnv"],
    host: nodeEnv === "production" ? "0.0.0.0" : "127.0.0.1",
    port,
    mysqlUrl,
    wechatAppId,
    wechatAppSecret: required(env, "WECHAT_APP_SECRET"),
    identityLookupKey,
    identityEncryptionKey
  };
}

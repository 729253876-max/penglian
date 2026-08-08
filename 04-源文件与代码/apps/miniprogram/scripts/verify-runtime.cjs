const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const buildRoot = path.resolve(
  __dirname,
  "..",
  "dist",
  "runtime-verify"
);
const temporaryRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "photo-ai-miniprogram-runtime-")
);
const isolatedRoot = path.join(temporaryRoot, "compiled");

async function verifyRuntime() {
  fs.cpSync(buildRoot, isolatedRoot, { recursive: true });
  fs.writeFileSync(
    path.join(isolatedRoot, "package.json"),
    '{"type":"module"}\n'
  );
  global.wx = {
    getStorageSync(key) {
      if (key !== "photo-ai:session") return undefined;
      return {
        accessToken: "runtime-check-access",
        accessExpiresAt: "2099-01-02T05:04:05.000Z",
        refreshToken: "runtime-check-refresh",
        refreshExpiresAt: "2099-02-01T05:04:05.000Z"
      };
    },
    removeStorageSync() {},
    reLaunch() {
      throw new Error("runtime verification unexpectedly left the task flow");
    },
    request(options) {
      assert.equal(
        options.header.Authorization,
        "Bearer runtime-check-access"
      );
      options.success({
        statusCode: 200,
        data: {
          taskId: "runtime-check",
          status: "SUCCEEDED",
          tool: "PORTRAIT_RETOUCH",
          lastSequence: 9,
          previewUrl:
            "https://example.invalid/demo-preview/portrait-natural.jpg"
        }
      });
    }
  };

  const client = await import(pathToFileURL(path.join(
    isolatedRoot,
    "services",
    "api.js"
  )).href);
  const snapshot = await client.getTask("runtime-check");
  assert.deepEqual(snapshot, {
    taskId: "runtime-check",
    status: "SUCCEEDED",
    tool: "PORTRAIT_RETOUCH",
    lastSequence: 9,
    previewUrl:
      "https://example.invalid/demo-preview/portrait-natural.jpg"
  });
  process.stdout.write(
    "miniprogram runtime verification passed without external modules\n"
  );
}

verifyRuntime()
  .catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  })
  .finally(() => {
    delete global.wx;
    const resolvedTemporaryRoot = path.resolve(temporaryRoot);
    const resolvedSystemTemp = `${path.resolve(os.tmpdir())}${path.sep}`;
    if (!resolvedTemporaryRoot.startsWith(resolvedSystemTemp)) {
      throw new Error("Refusing to clean a non-temporary runtime directory");
    }
    fs.rmSync(resolvedTemporaryRoot, { recursive: true, force: true });
  });

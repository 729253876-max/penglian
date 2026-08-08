import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

interface ProjectConfig {
  miniprogramRoot?: string;
  setting?: {
    urlCheck?: boolean;
  };
  scripts?: {
    beforeCompile?: string;
  };
}

interface AppConfig {
  pages?: string[];
}

interface PackageConfig {
  scripts?: Record<string, string>;
}

const expectedRuntimeFiles = [
  "app.js",
  "pages/home/index.js",
  "pages/live/index.js",
  "pages/plan/index.js",
  "pages/preview/index.js",
  "pages/privacy/index.js",
  "services/api.js",
  "services/edit-trace.js",
  "services/runtime-contracts.js",
  "services/session.js"
] as const;

const normalizeLineEndings = (content: string) =>
  content.replace(/\r\n?/g, "\n");

describe("WeChat project configuration", () => {
  it("exposes the runtime source directory as a directly openable WeChat project", () => {
    const runtimeProjectConfigUrl = new URL(
      "../miniprogram/project.config.json",
      import.meta.url
    );

    expect(existsSync(runtimeProjectConfigUrl)).toBe(true);

    const runtimeProjectConfig = JSON.parse(
      readFileSync(runtimeProjectConfigUrl, "utf8")
    ) as ProjectConfig;
    expect(runtimeProjectConfig.miniprogramRoot).toBe("./");
    expect(runtimeProjectConfig.scripts?.beforeCompile).toBe(
      "npm --prefix .. run build:wechat"
    );
  });

  it("allows the local phase A API from the runtime project", () => {
    const privateConfigUrl = new URL(
      "../miniprogram/project.private.config.json",
      import.meta.url
    );

    expect(existsSync(privateConfigUrl)).toBe(true);

    const privateConfig = JSON.parse(
      readFileSync(privateConfigUrl, "utf8")
    ) as ProjectConfig;
    expect(privateConfig.setting?.urlCheck).toBe(false);
  });

  it("keeps the checked-in JavaScript runtime synchronized with TypeScript", () => {
    const packageRoot = fileURLToPath(new URL("../", import.meta.url));
    const projectConfig = JSON.parse(
      readFileSync(new URL("../project.config.json", import.meta.url), "utf8")
    ) as ProjectConfig;
    const packageConfig = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8")
    ) as PackageConfig;
    const appConfig = JSON.parse(
      readFileSync(new URL("../miniprogram/app.json", import.meta.url), "utf8")
    ) as AppConfig;
    const buildConfigPath = fileURLToPath(
      new URL("../tsconfig.wechat.json", import.meta.url)
    );

    expect(projectConfig.scripts?.beforeCompile).toBe(
      "npm run build:wechat"
    );
    expect(packageConfig.scripts?.["build:wechat"]).toBe(
      "tsc -p tsconfig.wechat.json"
    );
    expect(existsSync(buildConfigPath)).toBe(true);

    const outputDirectory = mkdtempSync(join(tmpdir(), "wechat-build-"));
    try {
      const readResult = ts.readConfigFile(buildConfigPath, ts.sys.readFile);
      const parsed = ts.parseJsonConfigFileContent(
        readResult.config,
        ts.sys,
        packageRoot,
        { outDir: outputDirectory }
      );
      const program = ts.createProgram(parsed.fileNames, parsed.options);
      const emitResult = program.emit();
      const errors = ts
        .getPreEmitDiagnostics(program)
        .concat(emitResult.diagnostics)
        .filter(
          (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
        );

      expect(
        ts.formatDiagnosticsWithColorAndContext(errors, {
          getCanonicalFileName: (fileName) => fileName,
          getCurrentDirectory: () => packageRoot,
          getNewLine: () => "\n"
        })
      ).toBe("");
      expect(emitResult.emitSkipped).toBe(false);
      const expectedPageFiles = (appConfig.pages ?? []).map(
        (page) => `${page}.js`
      );
      expect(
        expectedRuntimeFiles.filter((fileName) =>
          fileName.startsWith("pages/")
        ).toSorted()
      ).toEqual(expectedPageFiles.toSorted());

      for (const fileName of expectedRuntimeFiles) {
        const emittedFile = join(outputDirectory, fileName);
        const checkedInFile = join(packageRoot, "miniprogram", fileName);

        expect(existsSync(emittedFile)).toBe(true);
        expect(existsSync(checkedInFile)).toBe(true);
        expect(
          normalizeLineEndings(readFileSync(checkedInFile, "utf8"))
        ).toBe(
          normalizeLineEndings(readFileSync(emittedFile, "utf8"))
        );
      }
      for (const page of appConfig.pages ?? []) {
        expect(existsSync(join(outputDirectory, `${page}.js`))).toBe(true);
      }
    } finally {
      rmSync(outputDirectory, { force: true, recursive: true });
    }
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

function expectValidJavaScript(path: string): void {
  const result = ts.transpileModule(readFileSync(resolve(path), "utf8"), {
    fileName: path,
    reportDiagnostics: true,
    compilerOptions: { allowJs: true, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  const errors = result.diagnostics?.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error) ?? [];
  expect(errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
}

describe("public assets", () => {
  it("ships syntactically valid JavaScript modules", () => {
    for (const path of ["public/app.js", "public/apartment-tools.js", "public/apartment.js", "public/sw.js"]) {
      expectValidJavaScript(path);
    }
  });

  it("renders apartment information as a direct navigation link", () => {
    const app = readFileSync(resolve("public/app.js"), "utf8");
    expect(app).toContain('href="/apartment.html" data-apartment-info=');
    expect(app).not.toContain('window.location.href = "/apartment.html"');
  });

  it("ships a valid web app manifest", () => {
    const manifest = JSON.parse(readFileSync(resolve("public/manifest.webmanifest"), "utf8"));
    expect(manifest).toMatchObject({ name: "MaidAid", start_url: "/", display: "standalone" });
  });

  it("refreshes the app shell from the network before using an offline fallback", () => {
    const serviceWorker = readFileSync(resolve("public/sw.js"), "utf8");
    expect(serviceWorker.indexOf("fetch(event.request)")).toBeLessThan(serviceWorker.indexOf("caches.match(event.request)"));
  });
});

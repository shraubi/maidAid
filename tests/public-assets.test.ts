import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

function expectValidJavaScript(path: string): void {
  const source = readFileSync(resolve(path), "utf8");
  const result = ts.transpileModule(source, {
    fileName: path,
    reportDiagnostics: true,
    compilerOptions: { allowJs: true, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  const errors = result.diagnostics?.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error) ?? [];
  expect(errors.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
  expect(() => new Function(source)).not.toThrow();
}

describe("public assets", () => {
  it("ships syntactically valid JavaScript modules", () => {
    for (const path of ["public/app.js", "public/sw.js"]) {
      expectValidJavaScript(path);
    }
  });

  it("uses permanent apartment routes instead of session storage handoff", () => {
    const app = readFileSync(resolve("public/app.js"), "utf8");
    expect(app).toContain("/map/apartments/");
    expect(app).not.toContain("writeSelectedApartment");
  });

  it("drops stale coordinates when an address or Maps link is edited", () => {
    const app = readFileSync(resolve("public/app.js"), "utf8");
    expect(app).toContain('$("#place-address").addEventListener("input", clearDerivedLocation)');
    expect(app).toContain('$("#place-maps-url").addEventListener("input", clearDerivedLocation)');
  });

  it("ships a valid web app manifest", () => {
    const manifest = JSON.parse(readFileSync(resolve("public/manifest.webmanifest"), "utf8"));
    expect(manifest).toMatchObject({ name: "MaidAid", start_url: "/", display: "standalone" });
  });

  it("retires the legacy offline shell instead of handling fetches", () => {
    const serviceWorker = readFileSync(resolve("public/sw.js"), "utf8");
    expect(serviceWorker).toContain("registration.unregister()");
    expect(serviceWorker).toContain('startsWith("maidaid-shell-")');
    expect(serviceWorker).not.toContain('addEventListener("fetch"');
  });
});

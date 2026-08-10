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

  it("renders typed map markers using the product palette", () => {
    const app = readFileSync(resolve("public/app.js"), "utf8");
    const styles = readFileSync(resolve("public/styles.css"), "utf8");
    const html = readFileSync(resolve("public/index.html"), "utf8");
    expect(app).toContain('map-marker--${appearance.colorClass}');
    expect(styles).toContain(".map-marker--apartment");
    expect(styles).toContain(".map-marker--laundry");
    expect(styles).toContain(".map-marker--partner_restaurant");
    expect(html).toContain('class="map-legend"');
  });

  it("uses structured Today cards with apartment search and a duration wheel", () => {
    const app = readFileSync(resolve("public/app.js"), "utf8");
    const html = readFileSync(resolve("public/index.html"), "utf8");
    expect(html).toContain('id="today-job-list"');
    expect(html).not.toContain('id="source-text"');
    expect(app).toContain('format: "structured"');
    expect(app).toContain("apartmentMatches");
    expect(app).toContain('class="duration-wheel"');
  });

  it("uses real month bounds, hides empty periods and closes dialogs from the backdrop", () => {
    const app = readFileSync(resolve("public/app.js"), "utf8");
    expect(app).toContain("const periodBounds");
    expect(app).toContain("new Date(year, month, 0).getDate()");
    expect(app).not.toContain("...periods.map(({ period }) => period)");
    expect(app).toContain("event.target === dialog");
  });

  it("uses one save-and-share action and warns only when later entries exist", () => {
    const app = readFileSync(resolve("public/app.js"), "utf8");
    const html = readFileSync(resolve("public/index.html"), "utf8");
    expect(html).not.toContain('id="save-day-button"');
    expect(html).not.toContain('id="copy-button"');
    expect(html).toContain("Сохранить и поделиться");
    expect(html).toContain('id="backdated-warning"');
    expect(app).toContain("data.hasLaterEntries");
  });

  it("allows Today cards and native controls to shrink on narrow iPhones", () => {
    const styles = readFileSync(resolve("public/styles.css"), "utf8");
    expect(styles).toContain(".today-job-card { width: 100%; min-width: 0;");
    expect(styles).toContain("input,select,textarea { width: 100%; min-width: 0; max-width: 100%;");
  });

  it("renders place kinds on their own line and makes laundry names optional", () => {
    const styles = readFileSync(resolve("public/styles.css"), "utf8");
    const app = readFileSync(resolve("public/app.js"), "utf8");
    expect(styles).toContain(".place-kind { display: block;");
    expect(app).toContain('laundry ? "Название (необязательно)"');
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

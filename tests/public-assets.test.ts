import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Script } from "node:vm";
import { describe, expect, it } from "vitest";

describe("public assets", () => {
  it("ships syntactically valid JavaScript", () => {
    expect(() => new Script(readFileSync(resolve("public/app.js"), "utf8"), { filename: "public/app.js" })).not.toThrow();
    expect(() => new Script(readFileSync(resolve("public/sw.js"), "utf8"), { filename: "public/sw.js" })).not.toThrow();
  });

  it("ships a valid web app manifest", () => {
    const manifest = JSON.parse(readFileSync(resolve("public/manifest.webmanifest"), "utf8"));
    expect(manifest).toMatchObject({ name: "MaidAid", start_url: "/", display: "standalone" });
  });
});


import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server.js";
import type { Config } from "../src/config.js";
import { MemoryLedgerStore } from "../src/storage/ledger-store.js";

const config: Config = {
  PORT: 3000, HOST: "127.0.0.1", LOG_LEVEL: "silent", PRODUCT_RELEASE: 2,
  HOURLY_RATE_CENTS: 1000, ORIENTATION_FLAT_CENTS: 1000, PRACTICE_FLAT_CENTS: 1500,
  CHECKIN_FLAT_CENTS: 1000, DRYER_DEFAULT_CENTS: 390,
  PREVIEW_RATE_LIMIT_MAX: 100, PREVIEW_RATE_LIMIT_WINDOW: "1 minute",
  DATABASE_URL: "unused", APARTMENT_IMPORT_TOKEN: "", TEAM_ACCESS_CODE: "shared-team-secret",
  INITIAL_CLEANER_NAME: "Current Cleaner", INITIAL_CLEANER_PIN: "123456", SESSION_DAYS: 90,
};

const cookie = (response: { headers: object }): string => String((response.headers as { "set-cookie"?: unknown })["set-cookie"]).split(";", 1)[0]!;

let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

describe("cleaner authentication and isolation", () => {
  it("requires authentication and remembers a valid login", async () => {
    app = await buildApp(config, new MemoryLedgerStore());
    expect((await app.inject({ method: "GET", url: "/api/ledger" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { name: "Current Cleaner", pin: "000000" } })).statusCode).toBe(401);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { name: " current  cleaner ", pin: "123456" } });
    expect(login.statusCode).toBe(200);
    const session = cookie(login);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: session } })).json().cleaner.name).toBe("Current Cleaner");
    expect((await app.inject({ method: "GET", url: "/api/ledger", headers: { cookie: session } })).statusCode).toBe(200);
    const logout = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie: session } });
    expect(logout.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: session } })).statusCode).toBe(401);
  });

  it("registers with the team code and isolates ledgers while sharing places", async () => {
    app = await buildApp(config, new MemoryLedgerStore());
    const firstLogin = await app.inject({ method: "POST", url: "/api/auth/login", payload: { name: "Current Cleaner", pin: "123456" } });
    const firstCookie = cookie(firstLogin);
    expect((await app.inject({ method: "POST", url: "/api/auth/register", payload: { teamCode: "wrong", name: "Colleague", pin: "654321" } })).statusCode).toBe(401);
    const registration = await app.inject({ method: "POST", url: "/api/auth/register", payload: { teamCode: "shared-team-secret", name: "Colleague", pin: "654321" } });
    expect(registration.statusCode).toBe(201);
    const secondCookie = cookie(registration);

    const text = "10/08/2026\nBosquet 9-12 уборка";
    expect((await app.inject({ method: "POST", url: "/api/days", headers: { cookie: firstCookie }, payload: { text } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/ledger", headers: { cookie: secondCookie } })).json().rows).toEqual([]);
    expect((await app.inject({ method: "POST", url: "/api/days", headers: { cookie: secondCookie }, payload: { text: "10/08/2026\nBosquet 9-11 уборка" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/ledger", headers: { cookie: firstCookie } })).json().totals.minutes).toBe(180);
    expect((await app.inject({ method: "GET", url: "/api/ledger", headers: { cookie: secondCookie } })).json().totals.minutes).toBe(120);

    const payment = await app.inject({ method: "POST", url: "/api/payments", headers: { cookie: firstCookie }, payload: { dateIso: "2026-08-10", amountCents: 1000 } });
    const paymentId = payment.json().payment.id;
    expect((await app.inject({ method: "DELETE", url: `/api/payments/${paymentId}`, headers: { cookie: secondCookie } })).statusCode).toBe(404);

    const apartment = await app.inject({ method: "POST", url: "/api/apartments", headers: { cookie: secondCookie }, payload: { canonicalName: "Shared Flat", aliases: [] } });
    expect(apartment.statusCode).toBe(201);
    const shared = await app.inject({ method: "GET", url: "/api/apartments", headers: { cookie: firstCookie } });
    expect(shared.json().apartments).toContainEqual(expect.objectContaining({ canonicalName: "Shared Flat" }));
  });
});

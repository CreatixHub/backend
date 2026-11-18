import request from "supertest";
import { describe, expect, it } from "vitest";
import { app, uniqueEmail, VALID_PASSWORD } from "./helpers";

const MOBILE_HEADER = { "X-Client": "mobile" };

// ---- helpers ----

/** Signs up as a mobile client and returns the parsed response body. */
async function mobileSignup(tag: string) {
  const email = uniqueEmail(tag);
  const res = await request(app)
    .post("/api/auth/signup")
    .set(MOBILE_HEADER)
    .send({ fullName: `${tag} Mobile`, email, password: VALID_PASSWORD });
  return { res, email };
}

/** Signs up then logs in as a mobile client. */
async function mobileLogin(tag: string) {
  const email = uniqueEmail(tag);
  await request(app)
    .post("/api/auth/signup")
    .send({ fullName: `${tag} Login`, email, password: VALID_PASSWORD }); // signup via web (doesn't matter)

  const res = await request(app)
    .post("/api/auth/login")
    .set(MOBILE_HEADER)
    .send({ email, password: VALID_PASSWORD });
  return { res, email };
}

// ---- B1: Mobile Client Detection ----

describe("B1: mobile client detection", () => {
  it("web signup does NOT include refreshToken in JSON", async () => {
    const email = uniqueEmail("b1-web");
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ fullName: "B1 Web", email, password: VALID_PASSWORD });

    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toContain("refreshToken");
    expect(res.headers["set-cookie"]?.[0]).toMatch(/^rt=/);
  });

  it("mobile signup DOES include refreshToken in JSON and no cookie", async () => {
    const { res } = await mobileSignup("b1-mob");

    expect(res.status).toBe(201);
    expect(res.body.data.refreshToken).toEqual(expect.any(String));
    expect(res.body.data.refreshToken.length).toBeGreaterThan(0);
    // no refresh cookie should be set for mobile
    const cookies = res.headers["set-cookie"] ?? [];
    const rtCookie = (Array.isArray(cookies) ? cookies : [cookies]).find((c: string) => c.startsWith("rt="));
    expect(rtCookie).toBeUndefined();
  });

  it("X-Client header is case insensitive", async () => {
    const email = uniqueEmail("b1-case");
    const res = await request(app)
      .post("/api/auth/signup")
      .set("X-Client", "Mobile")
      .send({ fullName: "B1 Case", email, password: VALID_PASSWORD });

    expect(res.status).toBe(201);
    expect(res.body.data.refreshToken).toEqual(expect.any(String));
  });
});

// ---- B2: Return Refresh Token for Mobile Clients ----

describe("B2: mobile login returns tokens in JSON", () => {
  it("login with X-Client: mobile returns accessToken AND refreshToken", async () => {
    const { res, email } = await mobileLogin("b2-login");

    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toEqual(expect.any(String));
    expect(res.body.data.refreshToken).toEqual(expect.any(String));
    expect(res.body.data.user.email).toBe(email);
    expect(res.body.data.expiresIn).toEqual(expect.any(Number));
  });

  it("mobile login preserves existing response fields", async () => {
    const { res } = await mobileLogin("b2-fields");

    const data = res.body.data;
    expect(data).toHaveProperty("accessToken");
    expect(data).toHaveProperty("refreshToken");
    expect(data).toHaveProperty("expiresIn");
    expect(data).toHaveProperty("user");
    expect(data).toHaveProperty("organizations");
    expect(data.user).toHaveProperty("id");
    expect(data.user).toHaveProperty("email");
    expect(data.user).toHaveProperty("name");
  });

  it("web login does NOT return refreshToken in JSON", async () => {
    const email = uniqueEmail("b2-web");
    await request(app)
      .post("/api/auth/signup")
      .send({ fullName: "B2 Web", email, password: VALID_PASSWORD });

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email, password: VALID_PASSWORD });

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain("refreshToken");
    expect(res.headers["set-cookie"]?.[0]).toMatch(/^rt=/);
  });
});

// ---- B3: Accept Mobile Refresh Token ----

describe("B3: mobile refresh using JSON body", () => {
  it("mobile refresh works using refreshToken from body", async () => {
    const { res: loginRes } = await mobileLogin("b3-refresh");
    const firstRefreshToken = loginRes.body.data.refreshToken;
    const firstAccessToken = loginRes.body.data.accessToken;

    const refreshRes = await request(app)
      .post("/api/auth/refresh")
      .set(MOBILE_HEADER)
      .send({ refreshToken: firstRefreshToken });

    expect(refreshRes.status).toBe(200);
    expect(refreshRes.body.data.accessToken).toEqual(expect.any(String));
    expect(refreshRes.body.data.accessToken).not.toBe(firstAccessToken);
    // rotation: the new refresh token must differ from the old one
    expect(refreshRes.body.data.refreshToken).toEqual(expect.any(String));
    expect(refreshRes.body.data.refreshToken).not.toBe(firstRefreshToken);
  });

  it("mobile refresh rotates the refresh token (old one stops working)", async () => {
    const { res: loginRes } = await mobileLogin("b3-rotate");
    const firstRT = loginRes.body.data.refreshToken;

    // first refresh succeeds
    await request(app)
      .post("/api/auth/refresh")
      .set(MOBILE_HEADER)
      .send({ refreshToken: firstRT });

    // wait a bit to exceed the grace window, then replay the old token
    await new Promise((r) => setTimeout(r, 150));

    const replay = await request(app)
      .post("/api/auth/refresh")
      .set(MOBILE_HEADER)
      .send({ refreshToken: firstRT });

    // must NOT succeed: the old token was already used
    expect(replay.status).not.toBe(200);
    expect([401, 409]).toContain(replay.status);
  });

  it("rejects mobile refresh when refreshToken is missing", async () => {
    const res = await request(app)
      .post("/api/auth/refresh")
      .set(MOBILE_HEADER)
      .send({});

    expect(res.status).toBe(400); // Zod validation error
  });

  it("rejects mobile refresh with an invalid token", async () => {
    const res = await request(app)
      .post("/api/auth/refresh")
      .set(MOBILE_HEADER)
      .send({ refreshToken: "totally-bogus-token" });

    expect(res.status).toBe(401);
  });

  it("web refresh still works with cookie (no body needed)", async () => {
    const agent = request.agent(app);
    const email = uniqueEmail("b3-web");
    const signup = await agent
      .post("/api/auth/signup")
      .send({ fullName: "B3 Web", email, password: VALID_PASSWORD });

    const firstAccessToken = signup.body.data.accessToken;
    const refreshRes = await agent.post("/api/auth/refresh").send();

    expect(refreshRes.status).toBe(200);
    expect(refreshRes.body.data.accessToken).not.toBe(firstAccessToken);
    expect(JSON.stringify(refreshRes.body)).not.toContain("refreshToken");
    expect(refreshRes.headers["set-cookie"]?.[0]).toMatch(/^rt=/);
  });

  it("web refresh without cookie returns 401", async () => {
    const res = await request(app).post("/api/auth/refresh").send();
    expect(res.status).toBe(401);
  });
});

// ---- Mobile Logout ----

describe("mobile logout", () => {
  it("mobile logout revokes the session so the token stops working", async () => {
    const { res: loginRes } = await mobileLogin("mob-logout");
    const rt = loginRes.body.data.refreshToken;

    const logoutRes = await request(app)
      .post("/api/auth/logout")
      .set(MOBILE_HEADER)
      .send({ refreshToken: rt });

    expect(logoutRes.status).toBe(204);

    // the refresh token should no longer work
    const afterLogout = await request(app)
      .post("/api/auth/refresh")
      .set(MOBILE_HEADER)
      .send({ refreshToken: rt });

    expect(afterLogout.status).toBe(401);
  });

  it("mobile logout without a token still succeeds (never fails)", async () => {
    const res = await request(app)
      .post("/api/auth/logout")
      .set(MOBILE_HEADER)
      .send();

    expect(res.status).toBe(204);
  });

  it("web logout still works with cookie", async () => {
    const agent = request.agent(app);
    await agent.post("/api/auth/signup").send({ fullName: "Web Logout", email: uniqueEmail("web-lo"), password: VALID_PASSWORD });

    const logoutRes = await agent.post("/api/auth/logout").send();
    expect(logoutRes.status).toBe(204);

    const afterLogout = await agent.post("/api/auth/refresh").send();
    expect(afterLogout.status).toBe(401);
  });
});

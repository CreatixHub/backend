import request from "supertest";
import { describe, expect, it } from "vitest";
import { app, uniqueEmail, VALID_PASSWORD } from "./helpers";

describe("signup", () => {
  it("creates an account and starts a session", async () => {
    const email = uniqueEmail("signup");
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ fullName: "New Person", email, password: VALID_PASSWORD });

    expect(res.status).toBe(201);
    expect(res.body.data.accessToken).toEqual(expect.any(String));
    expect(res.body.data.user.email).toBe(email);
    expect(res.body.data.user.organization).toBeNull(); // no school yet
    expect(res.body.data.organizations).toEqual([]);
    // the refresh token must never leak into the JSON body, only the cookie
    expect(JSON.stringify(res.body)).not.toContain("refreshToken");
    expect(res.headers["set-cookie"]?.[0]).toMatch(/^rt=/);
  });

  it("rejects a second signup with the same email", async () => {
    const email = uniqueEmail("dup");
    await request(app).post("/api/auth/signup").send({ fullName: "First", email, password: VALID_PASSWORD });
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ fullName: "Second", email, password: VALID_PASSWORD });

    expect(res.status).toBe(409);
  });

  it("rejects a password shorter than 10 characters", async () => {
    const res = await request(app)
      .post("/api/auth/signup")
      .send({ fullName: "Short Pw", email: uniqueEmail("short"), password: "tooshort" });

    expect(res.status).toBe(400);
  });
});

describe("login", () => {
  it("rejects a wrong password with the same generic message as an unknown email", async () => {
    const email = uniqueEmail("login");
    await request(app).post("/api/auth/signup").send({ fullName: "Login Test", email, password: VALID_PASSWORD });

    const wrongPassword = await request(app).post("/api/auth/login").send({ email, password: "not-the-password" });
    const unknownEmail = await request(app)
      .post("/api/auth/login")
      .send({ email: uniqueEmail("ghost"), password: VALID_PASSWORD });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body.message).toBe(unknownEmail.body.message);
  });

  it("logs in with the right password", async () => {
    const email = uniqueEmail("login-ok");
    await request(app).post("/api/auth/signup").send({ fullName: "Login OK", email, password: VALID_PASSWORD });

    const res = await request(app).post("/api/auth/login").send({ email, password: VALID_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toEqual(expect.any(String));
  });
});

describe("protected routes", () => {
  it("rejects a request with no Authorization header", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(401);
  });

  it("accepts a valid access token and returns the signed-in person", async () => {
    const email = uniqueEmail("me");
    const signup = await request(app)
      .post("/api/auth/signup")
      .send({ fullName: "Me Route", email, password: VALID_PASSWORD });

    const res = await request(app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${signup.body.data.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe(email);
  });
});

describe("refresh", () => {
  it("rotates the refresh token and issues a new access token", async () => {
    const agent = request.agent(app);
    const email = uniqueEmail("refresh");
    const signup = await agent
      .post("/api/auth/signup")
      .send({ fullName: "Refresh Test", email, password: VALID_PASSWORD });
    const firstAccessToken = signup.body.data.accessToken;

    // the agent automatically resends the rt cookie it was just given
    const refreshed = await agent.post("/api/auth/refresh").send();

    expect(refreshed.status).toBe(200);
    expect(refreshed.body.data.accessToken).toEqual(expect.any(String));
    expect(refreshed.body.data.accessToken).not.toBe(firstAccessToken);
    expect(refreshed.headers["set-cookie"]?.[0]).toMatch(/^rt=/);
  });

  it("rejects refresh when there is no cookie at all", async () => {
    const res = await request(app).post("/api/auth/refresh").send();
    expect(res.status).toBe(401);
  });

  it("does not let an already-rotated refresh token succeed again", async () => {
    const agent = request.agent(app);
    await agent.post("/api/auth/signup").send({ fullName: "Reuse Test", email: uniqueEmail("reuse"), password: VALID_PASSWORD });

    // grab the cookie supertest's agent is holding, so we can replay the ORIGINAL one after rotation
    type Jar = { getCookies: (opts: Record<string, unknown>) => { name: string; value: string }[] };
    const jar = (agent as unknown as { jar: Jar }).jar;
    const [original] = jar.getCookies({ domain: "127.0.0.1", path: "/api/auth", secure: false, script: false });
    const originalCookieHeader = original ? `${original.name}=${original.value}` : "";

    await agent.post("/api/auth/refresh").send(); // rotates: the original cookie is now "used"

    const replay = await request(app).post("/api/auth/refresh").set("Cookie", originalCookieHeader).send();

    // immediate replay (<10s) is treated as a harmless race (409); replaying it again later is 401 (theft).
    // Either way it must NOT succeed with a fresh 200 - that would mean a used token works twice.
    expect(replay.status).not.toBe(200);
    expect([401, 409]).toContain(replay.status);
  });
});

describe("logout", () => {
  it("revokes the session so the refresh cookie stops working", async () => {
    const agent = request.agent(app);
    await agent.post("/api/auth/signup").send({ fullName: "Logout Test", email: uniqueEmail("logout"), password: VALID_PASSWORD });

    const logout = await agent.post("/api/auth/logout").send();
    expect(logout.status).toBe(204);

    const refreshAfterLogout = await agent.post("/api/auth/refresh").send();
    expect(refreshAfterLogout.status).toBe(401);
  });

  it("never fails even with no session to log out of", async () => {
    const res = await request(app).post("/api/auth/logout").send();
    expect(res.status).toBe(204);
  });
});

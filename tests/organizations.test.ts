import request from "supertest";
import { describe, expect, it } from "vitest";
import { app, signupAndLogin, uniqueSlug } from "./helpers";

describe("organizations & tenant permissions", () => {
  it("lets a signed-in person create a school and become its owner", async () => {
    const { agent } = await signupAndLogin("org-owner");
    const slug = uniqueSlug("acme");

    const res = await agent.post("/api/organizations").send({ name: "Acme School", slug });

    expect(res.status).toBe(201);
    expect(res.body.data.slug).toBe(slug);
    expect(res.body.data.roles).toEqual(["owner"]);
  });

  it("403s on a tenant-scoped route when the token carries no school yet", async () => {
    const { agent } = await signupAndLogin("no-school");

    // never created or switched into a school - the token has no `tid`
    const res = await agent.get("/api/organizations/current");

    expect(res.status).toBe(403);
  });

  it("switching into the new school grants owner permissions there", async () => {
    const { agent, switchOrganization } = await signupAndLogin("org-switch");
    const slug = uniqueSlug("switchy");
    await agent.post("/api/organizations").send({ name: "Switchy School", slug });

    // creating a school does NOT itself hand back a token carrying it - must switch first
    const beforeSwitch = await agent.get("/api/organizations/current");
    expect(beforeSwitch.status).toBe(403);

    const switched = await switchOrganization(slug);
    expect(switched.status).toBe(200);
    expect(switched.body.data.organization.slug).toBe(slug);

    const current = await agent.get("/api/organizations/current");
    expect(current.status).toBe(200);
    expect(current.body.data.slug).toBe(slug);
    expect(current.body.data.myRoles).toEqual(["owner"]);
  });

  it("refuses to switch into a school the person does not belong to", async () => {
    const { switchOrganization } = await signupAndLogin("org-outsider");
    const res = await switchOrganization("some-school-nobody-is-in");
    expect(res.status).toBe(403);
  });

  it("rejects a duplicate slug", async () => {
    const { agent } = await signupAndLogin("org-dup-owner");
    const slug = uniqueSlug("dupe");
    await agent.post("/api/organizations").send({ name: "First", slug });

    const { agent: otherAgent } = await signupAndLogin("org-dup-other");
    const res = await otherAgent.post("/api/organizations").send({ name: "Second", slug });

    expect(res.status).toBe(409);
  });
});

describe("unmatched routes", () => {
  it("rejects an unauthenticated request before it ever reaches route matching", async () => {
    // authenticate is mounted on ALL of /api, so even a nonexistent path 401s, not 404s, when signed out
    const res = await request(app).get("/api/this-route-does-not-exist");
    expect(res.status).toBe(401);
  });

  it("404s cleanly (not a stack trace) when signed in but the route still doesn't exist", async () => {
    const { agent } = await signupAndLogin("not-found");
    const res = await agent.get("/api/this-route-does-not-exist");
    expect(res.status).toBe(404);
    expect(res.body.message).toBeTruthy();
  });
});

import request from "supertest";
import { createApp } from "../src/app";

// One Express app for the whole test run (same pattern app.ts's own comment describes: build it with
// createApp() so it can be imported without a real HTTP server/port).
export const app = createApp();

// Unique-per-run names, same trick as scripts/check-all.sh: never collide across runs, never need cleanup.
const RUN = Date.now().toString(36);
let counter = 0;
const next = () => `${RUN}${(counter++).toString(36)}`;

export const uniqueEmail = (tag: string) => `${tag}-${next()}@example.test`;
export const uniqueSlug = (tag: string) => `${tag}-${next()}`;

export const VALID_PASSWORD = "a-fine-password-10plus";

// An agent that persists the httpOnly refresh-token cookie AND attaches the current access token
// (as a Bearer header) to every request automatically, so tests don't have to repeat `.set(...)`.
export interface AuthedAgent {
  get: (url: string) => request.Test;
  post: (url: string) => request.Test;
  patch: (url: string) => request.Test;
  put: (url: string) => request.Test;
  delete: (url: string) => request.Test;
  accessToken: string;
}

function wrapWithBearer(rawAgent: ReturnType<typeof request.agent>, holder: { token: string }): AuthedAgent {
  const withAuth = (method: "get" | "post" | "patch" | "put" | "delete") => (url: string) =>
    rawAgent[method](url).set("Authorization", `Bearer ${holder.token}`);
  return {
    get: withAuth("get"),
    post: withAuth("post"),
    patch: withAuth("patch"),
    put: withAuth("put"),
    delete: withAuth("delete"),
    get accessToken() {
      return holder.token;
    },
  };
}

export async function signupAndLogin(tag: string) {
  const email = uniqueEmail(tag);
  const rawAgent = request.agent(app); // persists the httpOnly refresh-token cookie across requests
  const res = await rawAgent
    .post("/api/auth/signup")
    .send({ fullName: `${tag} Test`, email, password: VALID_PASSWORD });
  const holder = { token: res.body.data.accessToken as string };
  const agent = wrapWithBearer(rawAgent, holder);

  // switch-organization and refresh both hand back a NEW access token - keep the agent's header in sync
  const switchOrganization = async (organization: string) => {
    const r = await rawAgent
      .post("/api/auth/switch-organization")
      .set("Authorization", `Bearer ${holder.token}`)
      .send({ organization });
    if (r.body?.data?.accessToken) holder.token = r.body.data.accessToken;
    return r;
  };

  return { agent, switchOrganization, email, accessToken: res.body.data.accessToken as string, body: res.body };
}

// The id of the current academic year of the school the agent is signed in to (a new school gets one automatically).
// Use this instead of a literal 1: academic_year_id is a real foreign key, and ids are global across schools.
export async function currentAcademicYearId(agent: AuthedAgent): Promise<string> {
  const res = await agent.get("/api/academic-years/current");
  if (res.status !== 200) throw new Error(`GET /api/academic-years/current returned ${res.status}`);
  return res.body.data.id as string;
}

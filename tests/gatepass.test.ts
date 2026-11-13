import request from "supertest";
import { describe, expect, it } from "vitest";
import { VALID_PASSWORD, app, signupAndLogin, uniqueEmail, uniqueSlug } from "./helpers";

async function setupSchool(tag: string) {
  const ctx = await signupAndLogin(tag);
  const slug = uniqueSlug(tag);
  const orgRes = await ctx.agent.post("/api/organizations").send({ name: `${tag} School`, slug });
  expect(orgRes.status).toBe(201);
  await ctx.switchOrganization(slug);
  return { ...ctx, slug };
}

describe("Task 3 — Gate Pass (exit_passes)", () => {
  it("enforces pickup authorization, approval, passCode verification, single-use gate exit, return, and ownership", async () => {
    const schoolA = await setupSchool("gp-a");
    const schoolB = await setupSchool("gp-b");

    // Create Student A1 (with login) and Student A2
    const studEmail = uniqueEmail("gp-stud");
    const memStud = await schoolA.agent.post("/api/members").send({
      email: studEmail,
      fullName: "Student GP",
      password: VALID_PASSWORD,
      userType: "student",
      roles: ["student"],
    });
    expect(memStud.status).toBe(201);

    // Security staff user (`security` role has all gatepass.* permissions)
    const secEmail = uniqueEmail("gp-sec");
    const memSec = await schoolA.agent.post("/api/members").send({
      email: secEmail,
      fullName: "Gate Guard",
      password: VALID_PASSWORD,
      userType: "staff",
      roles: ["security"],
    });
    expect(memSec.status).toBe(201);

    const gAuthRes = await schoolA.agent.post("/api/guardians").send({
      fullName: "Authorized Parent",
      relation: "mother",
      phone: "9111111111",
      isEmergencyContact: true,
    });
    expect(gAuthRes.status).toBe(201);
    const authGuardianId = gAuthRes.body.data.id as string;

    const gNoPickupRes = await schoolA.agent.post("/api/guardians").send({
      fullName: "No Pickup Uncle",
      relation: "other",
      phone: "9222222222",
      isEmergencyContact: false,
    });
    expect(gNoPickupRes.status).toBe(201);
    const noPickupGuardianId = gNoPickupRes.body.data.id as string;

    const s1Res = await schoolA.agent.post("/api/students").send({
      userId: memStud.body.data.userId,
      firstName: "Aarav",
      lastName: "Kumar",
      dob: "2013-02-14",
      admittedOn: "2026-06-01",
      guardians: [
        { guardianId: authGuardianId, isPrimary: true, canPickUp: true },
        { guardianId: noPickupGuardianId, isPrimary: false, canPickUp: false },
      ],
    });
    expect(s1Res.status).toBe(201);
    const s1Id = s1Res.body.data.id as string;

    const s2Res = await schoolA.agent.post("/api/students").send({
      firstName: "Other",
      lastName: "Student",
      dob: "2013-09-01",
      admittedOn: "2026-06-01",
    });
    expect(s2Res.status).toBe(201);
    const s2Id = s2Res.body.data.id as string;

    // 1. Guardian with canPickUp=false is rejected
    const badPickup = await schoolA.agent.post("/api/exit-passes").send({
      studentId: s1Id,
      pickedUpByGuardianId: noPickupGuardianId,
      reason: "Medical checkup",
      reasonType: "medical",
      requestedExitAt: "2026-09-20T11:00:00Z",
      expectedReturnAt: "2026-09-20T14:00:00Z",
    });
    expect(badPickup.status).toBe(403);

    // 2. Student A1 creates pass for self, blocked from creating for Student A2
    const studLogin = await request(app)
      .post("/api/auth/login")
      .send({ email: studEmail, password: VALID_PASSWORD, organization: schoolA.slug });
    expect(studLogin.status).toBe(200);
    const studToken = studLogin.body.data.accessToken as string;

    const studForbidden = await request(app)
      .post("/api/exit-passes")
      .set("Authorization", `Bearer ${studToken}`)
      .send({
        studentId: s2Id,
        reason: "Not mine",
        reasonType: "personal",
        requestedExitAt: "2026-09-20T11:00:00Z",
        expectedReturnAt: "2026-09-20T13:00:00Z",
      });
    expect(studForbidden.status).toBe(403);

    const studPass = await request(app)
      .post("/api/exit-passes")
      .set("Authorization", `Bearer ${studToken}`)
      .send({
        studentId: s1Id,
        pickedUpByGuardianId: authGuardianId,
        reason: "Dental appointment",
        reasonType: "medical",
        requestedExitAt: "2026-09-20T11:00:00Z",
        expectedReturnAt: "2026-09-20T13:30:00Z",
      });
    expect(studPass.status).toBe(201);
    expect(studPass.body.data.status).toBe("pending");
    const passId = studPass.body.data.id as string;
    const passCode = studPass.body.data.passCode as string;

    // Security approves, verifies by passCode, marks used once (second use -> 409), and records return
    const secLogin = await request(app)
      .post("/api/auth/login")
      .send({ email: secEmail, password: VALID_PASSWORD, organization: schoolA.slug });
    expect(secLogin.status).toBe(200);
    const secToken = secLogin.body.data.accessToken as string;

    const verifyPending = await request(app)
      .post("/api/exit-passes/verify")
      .set("Authorization", `Bearer ${secToken}`)
      .send({ passCode });
    expect(verifyPending.status).toBe(200);
    expect(verifyPending.body.data.valid).toBe(false);

    const approveRes = await request(app)
      .post(`/api/exit-passes/${passId}/decide`)
      .set("Authorization", `Bearer ${secToken}`)
      .send({ decision: "approved" });
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.data.status).toBe("approved");

    const verifyApproved = await request(app)
      .post("/api/exit-passes/verify")
      .set("Authorization", `Bearer ${secToken}`)
      .send({ passCode });
    expect(verifyApproved.status).toBe(200);
    expect(verifyApproved.body.data.valid).toBe(true);

    const useRes = await request(app)
      .post(`/api/exit-passes/${passId}/use`)
      .set("Authorization", `Bearer ${secToken}`)
      .send({});
    expect(useRes.status).toBe(200);
    expect(useRes.body.data.status).toBe("used");
    expect(useRes.body.data.usedAt).toBeTruthy();

    const reuseRes = await request(app)
      .post(`/api/exit-passes/${passId}/use`)
      .set("Authorization", `Bearer ${secToken}`)
      .send({});
    expect(reuseRes.status).toBe(409);

    const returnRes = await request(app)
      .post(`/api/exit-passes/${passId}/return`)
      .set("Authorization", `Bearer ${secToken}`)
      .send({});
    expect(returnRes.status).toBe(200);
    expect(returnRes.body.data.actualReturnAt).toBeTruthy();

    // School B cannot see or verify School A's exit pass
    const crossGet = await schoolB.agent.get(`/api/exit-passes/${passId}`);
    expect(crossGet.status).toBe(404);
    const crossVerify = await schoolB.agent.post("/api/exit-passes/verify").send({ passCode });
    expect(crossVerify.status).toBe(404);
  });
});

import { inArray } from "drizzle-orm";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { db } from "../src/db";
import { permissions, rolePermissions } from "../src/db/schema";
import { VALID_PASSWORD, app, signupAndLogin, uniqueEmail, uniqueSlug } from "./helpers";

describe("Task 4 — Parent & Student Row-Level Ownership Security", () => {
  it("scopes students, guardians, leave requests, invoices, payments, and fails closed on enrollment-only tables", async () => {
    const owner = await signupAndLogin("own-owner");
    const slug = uniqueSlug("own-school");
    const orgRes = await owner.agent.post("/api/organizations").send({ name: "Ownership School", slug });
    expect(orgRes.status).toBe(201);
    await owner.switchOrganization(slug);

    // Grant `students.view` & `leaves.view` to this test school's `parent` role so we also exercise those GET routes
    const rolesRes = await owner.agent.get("/api/roles");
    expect(rolesRes.status).toBe(200);
    const parentRole = (rolesRes.body.data as { id: string; code: string }[]).find((r) => r.code === "parent")!;
    const extraPerms = await db
      .select({ id: permissions.id })
      .from(permissions)
      .where(inArray(permissions.code, ["students.view", "leaves.view"]));
    await db
      .insert(rolePermissions)
      .values(
        extraPerms.map((p) => ({
          tenantId: BigInt(orgRes.body.data.id),
          roleId: BigInt(parentRole.id),
          permissionId: p.id,
        })),
      )
      .onConflictDoNothing();

    // Create Parent A, Parent B, Student A1 user, Teacher+Parent hybrid user
    const parentAEmail = uniqueEmail("parent-a");
    const parentBEmail = uniqueEmail("parent-b");
    const studA1Email = uniqueEmail("student-a1");

    const memPA = await owner.agent.post("/api/members").send({
      email: parentAEmail,
      fullName: "Parent A",
      password: VALID_PASSWORD,
      userType: "guardian",
      roles: ["parent"],
    });
    expect(memPA.status).toBe(201);
    const parentAUserId = memPA.body.data.userId as string;

    const memPB = await owner.agent.post("/api/members").send({
      email: parentBEmail,
      fullName: "Parent B",
      password: VALID_PASSWORD,
      userType: "guardian",
      roles: ["parent"],
    });
    expect(memPB.status).toBe(201);
    const parentBUserId = memPB.body.data.userId as string;

    const memSA1 = await owner.agent.post("/api/members").send({
      email: studA1Email,
      fullName: "Student A1",
      password: VALID_PASSWORD,
      userType: "student",
      roles: ["student"],
    });
    expect(memSA1.status).toBe(201);
    const studentA1UserId = memSA1.body.data.userId as string;

    // Create Guardians linked to user accounts
    const gARes = await owner.agent.post("/api/guardians").send({
      userId: parentAUserId,
      fullName: "Guardian A",
      relation: "father",
      phone: "9000000001",
      isEmergencyContact: true,
    });
    expect(gARes.status).toBe(201);
    const guardianAId = gARes.body.data.id as string;

    const gBRes = await owner.agent.post("/api/guardians").send({
      userId: parentBUserId,
      fullName: "Guardian B",
      relation: "mother",
      phone: "9000000002",
      isEmergencyContact: true,
    });
    expect(gBRes.status).toBe(201);
    const guardianBId = gBRes.body.data.id as string;

    // Create Students: A1 & A2 linked to Parent A (siblings); B1 linked to Parent B
    const sA1Res = await owner.agent.post("/api/students").send({
      userId: studentA1UserId,
      firstName: "Child",
      lastName: "A1",
      dob: "2013-01-10",
      admittedOn: "2026-06-01",
      guardians: [{ guardianId: guardianAId, isPrimary: true, canPickUp: true }],
    });
    expect(sA1Res.status).toBe(201);
    const sA1Id = sA1Res.body.data.id as string;

    const sA2Res = await owner.agent.post("/api/students").send({
      firstName: "Child",
      lastName: "A2",
      dob: "2015-04-15",
      admittedOn: "2026-06-01",
      guardians: [{ guardianId: guardianAId, isPrimary: true, canPickUp: true }],
    });
    expect(sA2Res.status).toBe(201);
    const sA2Id = sA2Res.body.data.id as string;

    const sB1Res = await owner.agent.post("/api/students").send({
      firstName: "Child",
      lastName: "B1",
      dob: "2014-07-20",
      admittedOn: "2026-06-01",
      guardians: [{ guardianId: guardianBId, isPrimary: true, canPickUp: true }],
    });
    expect(sB1Res.status).toBe(201);
    const sB1Id = sB1Res.body.data.id as string;

    // Seed Invoices, Payments, and Leave Requests for all 3 students
    const mkInv = (studentId: string, num: string) =>
      owner.agent.post("/api/invoices").send({
        number: num,
        studentId,
        academicYearId: "1",
        issuedOn: "2026-08-01",
        dueOn: "2026-08-15",
        lines: [{ lineType: "fee", quantity: 1, unitAmount: 1000 }],
      });
    const invA1 = await mkInv(sA1Id, "INV-OWN-A1");
    const invA2 = await mkInv(sA2Id, "INV-OWN-A2");
    const invB1 = await mkInv(sB1Id, "INV-OWN-B1");
    expect(invA1.status).toBe(201);
    expect(invA2.status).toBe(201);
    expect(invB1.status).toBe(201);

    const payA1 = await owner.agent.post("/api/payments").send({ studentId: sA1Id, amount: 1000, method: "cash" });
    const payB1 = await owner.agent.post("/api/payments").send({ studentId: sB1Id, amount: 1000, method: "cash" });
    expect(payA1.status).toBe(201);
    expect(payB1.status).toBe(201);

    const lrA1 = await owner.agent.post("/api/leave-requests").send({
      studentId: sA1Id,
      fromDate: "2026-09-10",
      toDate: "2026-09-10",
      days: 1,
      durationType: "full_day",
      reason: "A1 fever",
    });
    const lrB1 = await owner.agent.post("/api/leave-requests").send({
      studentId: sB1Id,
      fromDate: "2026-09-11",
      toDate: "2026-09-11",
      days: 1,
      durationType: "full_day",
      reason: "B1 fever",
    });
    expect(lrA1.status).toBe(201);
    expect(lrB1.status).toBe(201);

    // Log in as Parent A & Student A1
    const loginPA = await request(app).post("/api/auth/login").send({ email: parentAEmail, password: VALID_PASSWORD, organization: slug });
    expect(loginPA.status).toBe(200);
    const tokenPA = loginPA.body.data.accessToken as string;

    const loginSA1 = await request(app).post("/api/auth/login").send({ email: studA1Email, password: VALID_PASSWORD, organization: slug });
    expect(loginSA1.status).toBe(200);
    const tokenSA1 = loginSA1.body.data.accessToken as string;

    // 1. Parent A sees BOTH siblings (A1, A2), never B1
    const paStudents = await request(app).get("/api/students").set("Authorization", `Bearer ${tokenPA}`);
    expect(paStudents.status).toBe(200);
    expect(paStudents.body.data.map((s: { id: string }) => s.id).sort()).toEqual([sA1Id, sA2Id].sort());

    const paOtherStudent = await request(app).get(`/api/students/${sB1Id}`).set("Authorization", `Bearer ${tokenPA}`);
    expect(paOtherStudent.status).toBe(404);

    const paInvoices = await request(app).get("/api/invoices").set("Authorization", `Bearer ${tokenPA}`);
    expect(paInvoices.status).toBe(200);
    expect(paInvoices.body.data.map((i: { id: string }) => i.id).sort()).toEqual(
      [invA1.body.data.id, invA2.body.data.id].sort(),
    );

    const paOtherInv = await request(app)
      .get(`/api/invoices/${invB1.body.data.id}`)
      .set("Authorization", `Bearer ${tokenPA}`);
    expect(paOtherInv.status).toBe(404);

    const paPayments = await request(app).get("/api/payments").set("Authorization", `Bearer ${tokenPA}`);
    expect(paPayments.status).toBe(200);
    expect(paPayments.body.data.map((p: { id: string }) => p.id)).toEqual([payA1.body.data.id]);

    const paOtherPay = await request(app)
      .get(`/api/payments/${payB1.body.data.id}`)
      .set("Authorization", `Bearer ${tokenPA}`);
    expect(paOtherPay.status).toBe(404);

    // Parent A can request leave for sibling A2, but NOT B1 or nonexistent student
    const paCreateOwn = await request(app)
      .post("/api/leave-requests")
      .set("Authorization", `Bearer ${tokenPA}`)
      .send({
        studentId: sA2Id,
        fromDate: "2026-09-12",
        toDate: "2026-09-12",
        days: 1,
        durationType: "full_day",
        reason: "Dentist",
      });
    expect(paCreateOwn.status).toBe(201);

    const paCreateOther = await request(app)
      .post("/api/leave-requests")
      .set("Authorization", `Bearer ${tokenPA}`)
      .send({
        studentId: sB1Id,
        fromDate: "2026-09-12",
        toDate: "2026-09-12",
        days: 1,
        durationType: "full_day",
        reason: "IDOR attempt",
      });
    expect(paCreateOther.status).toBe(403);

    const paCreateNonExistent = await request(app)
      .post("/api/leave-requests")
      .set("Authorization", `Bearer ${tokenPA}`)
      .send({
        studentId: "999999999",
        fromDate: "2026-09-12",
        toDate: "2026-09-12",
        days: 1,
        durationType: "full_day",
        reason: "Probe",
      });
    expect(paCreateNonExistent.status).toBe(403);

    // Fail closed on enrollment-only table (student-attendance)
    const paAtt = await request(app).get("/api/student-attendance").set("Authorization", `Bearer ${tokenPA}`);
    expect(paAtt.status).toBe(200);
    expect(paAtt.body.data).toEqual([]);

    // 2. Student A1 sees ONLY own leave requests (not sibling A2, not B1)
    const sa1Leaves = await request(app).get("/api/leave-requests").set("Authorization", `Bearer ${tokenSA1}`);
    expect(sa1Leaves.status).toBe(200);
    expect(sa1Leaves.body.data.map((l: { id: string }) => l.id)).toEqual([lrA1.body.data.id]);

    const sa1OtherLeave = await request(app)
      .get(`/api/leave-requests/${lrB1.body.data.id}`)
      .set("Authorization", `Bearer ${tokenSA1}`);
    expect(sa1OtherLeave.status).toBe(404);

    const sa1CreateSibling = await request(app)
      .post("/api/leave-requests")
      .set("Authorization", `Bearer ${tokenSA1}`)
      .send({
        studentId: sA2Id,
        fromDate: "2026-09-15",
        toDate: "2026-09-15",
        days: 1,
        durationType: "full_day",
        reason: "Not mine",
      });
    expect(sa1CreateSibling.status).toBe(403);
  });
});

import request from "supertest";
import { describe, expect, it } from "vitest";
import { app, signupAndLogin, uniqueSlug } from "./helpers";

const putWith = (token: string, url: string) => request(app).put(url).set("Authorization", `Bearer ${token}`);

async function setupSchool(tag: string) {
  const ctx = await signupAndLogin(tag);
  const slug = uniqueSlug(tag);
  const orgRes = await ctx.agent.post("/api/organizations").send({ name: `${tag} School`, slug });
  expect(orgRes.status).toBe(201);
  await ctx.switchOrganization(slug);
  return { ...ctx, slug, orgId: orgRes.body.data.id as string };
}

describe("Task 1 — Attendance, Holidays & Leaves", () => {
  it("handles student & staff attendance upsert, bulk mark, rules, calendar holidays, and leaves lifecycle", async () => {
    const schoolA = await setupSchool("att-a");
    const schoolB = await setupSchool("att-b");

    // 1. Create a staff member and a student in School A
    const staffRes = await schoolA.agent.post("/api/staff").send({
      staffType: "teaching",
      employmentType: "full_time",
      firstName: "Asha",
      lastName: "Menon",
      joinedOn: "2026-06-01",
    });
    expect(staffRes.status).toBe(201);
    const staffId = staffRes.body.data.id as string;

    const studentRes = await schoolA.agent.post("/api/students").send({
      firstName: "Rohan",
      lastName: "Nair",
      dob: "2014-05-12",
      admittedOn: "2026-06-01",
    });
    expect(studentRes.status).toBe(201);
    const studentId = studentRes.body.data.id as string;

    // 2. Student attendance upsert & bulk mark & list
    const enrollmentId1 = String(Date.now());
    const enrollmentId2 = String(Date.now() + 1);

    const saUpsert = await putWith(schoolA.agent.accessToken, "/api/student-attendance").send({
      enrollmentId: enrollmentId1,
      attendanceDate: "2026-09-01",
      status: "present",
      checkIn: "08:30",
      source: "manual",
    });
    expect(saUpsert.status).toBe(200);
    expect(saUpsert.body.data.status).toBe("present");

    const saBulk = await schoolA.agent.post("/api/student-attendance/bulk").send({
      attendanceDate: "2026-09-02",
      source: "biometric",
      records: [
        { enrollmentId: enrollmentId1, status: "late", checkIn: "08:50" },
        { enrollmentId: enrollmentId2, status: "absent", remarks: "Sick" },
      ],
    });
    expect(saBulk.status).toBe(200);
    expect(saBulk.body.data).toHaveLength(2);

    const saList = await schoolA.agent.get(`/api/student-attendance?enrollmentId=${enrollmentId1}`);
    expect(saList.status).toBe(200);
    expect(saList.body.data).toHaveLength(2);

    // Tenant B cannot see School A's attendance
    const sbList = await schoolB.agent.get("/api/student-attendance");
    expect(sbList.status).toBe(200);
    expect(sbList.body.data).toHaveLength(0);

    // 3. Staff attendance + computed workedMinutes
    const stAtt = await putWith(schoolA.agent.accessToken, "/api/staff-attendance").send({
      staffId,
      attendanceDate: "2026-09-01",
      status: "present",
      checkIn: "2026-09-01T08:30:00Z",
      checkOut: "2026-09-01T16:30:00Z",
      source: "manual",
    });
    expect(stAtt.status).toBe(200);
    expect(stAtt.body.data.workedMinutes).toBe(480);

    // 4. Attendance rules
    const ruleRes = await schoolA.agent.post("/api/attendance-rules").send({
      audience: "student",
      name: "Default Morning Rule",
      lateAfter: "08:45",
      halfDayAfter: "10:00",
      absentAfter: "11:00",
      minAttendancePercent: 75,
      graceMinutes: 10,
      workingWeekdays: [1, 2, 3, 4, 5],
      effectiveFrom: "2026-06-01",
      effectiveTo: "2027-03-31",
      isActive: true,
    });
    expect(ruleRes.status).toBe(201);
    expect(ruleRes.body.data.workingWeekdays).toEqual([1, 2, 3, 4, 5]);

    // 5. Academic calendar events (holidays)
    const holidayRes = await schoolA.agent.post("/api/calendar-events").send({
      title: "Independence Day",
      eventType: "holiday",
      startsAt: "2026-08-15T00:00:00Z",
      endsAt: "2026-08-15T23:59:59Z",
      allDay: true,
      audience: "all",
      notifyVia: ["app", "sms"],
    });
    expect(holidayRes.status).toBe(201);

    const examRes = await schoolA.agent.post("/api/calendar-events").send({
      title: "Midterm Exam",
      eventType: "exam",
      startsAt: "2026-10-05T09:00:00Z",
      endsAt: "2026-10-05T12:00:00Z",
      allDay: false,
      audience: "students",
    });
    expect(examRes.status).toBe(201);

    const holidaysList = await schoolA.agent.get("/api/calendar-events?eventType=holiday");
    expect(holidaysList.status).toBe(200);
    expect(holidaysList.body.data).toHaveLength(1);
    expect(holidaysList.body.data[0].title).toBe("Independence Day");

    // 6. Leave types, leave balances & leave requests workflow
    const ltRes = await schoolA.agent.post("/api/leave-types").send({
      code: "CL",
      name: "Casual Leave",
      isPaid: true,
      annualQuota: 12,
      maxConsecutiveDays: 3,
      requiresDocument: false,
      applicableTo: "staff",
      leaveCategory: "casual",
      accrualBasis: "annual",
      isActive: true,
    });
    expect(ltRes.status).toBe(201);
    const leaveTypeId = ltRes.body.data.id as string;

    // Duplicate code returns 409
    const ltDup = await schoolA.agent.post("/api/leave-types").send({
      code: "cl",
      name: "Dup Leave",
      applicableTo: "staff",
      leaveCategory: "casual",
      accrualBasis: "annual",
    });
    expect(ltDup.status).toBe(409);

    const balRes = await putWith(schoolA.agent.accessToken, "/api/leave-balances").send({
      staffId,
      leaveTypeId,
      academicYearId: "1",
      allocated: 10,
      used: 0,
      carriedForward: 2,
    });
    expect(balRes.status).toBe(200);
    const balId = balRes.body.data.id as string;

    // Applying staff-only leave type to student fails 400
    const badStudLeave = await schoolA.agent.post("/api/leave-requests").send({
      studentId,
      leaveTypeId,
      fromDate: "2026-09-10",
      toDate: "2026-09-11",
      days: 2,
      durationType: "full_day",
      reason: "Family trip",
    });
    expect(badStudLeave.status).toBe(400);

    // Valid staff leave request
    const lrRes = await schoolA.agent.post("/api/leave-requests").send({
      staffId,
      leaveTypeId,
      fromDate: "2026-09-10",
      toDate: "2026-09-11",
      days: 2,
      durationType: "full_day",
      reason: "Personal work",
    });
    expect(lrRes.status).toBe(201);
    expect(lrRes.body.data.status).toBe("pending");
    const leaveRequestId = lrRes.body.data.id as string;

    // School B cannot access School A's leave request
    const crossGet = await schoolB.agent.get(`/api/leave-requests/${leaveRequestId}`);
    expect(crossGet.status).toBe(404);

    // Approve deducts from leave balance
    const approveRes = await schoolA.agent.post(`/api/leave-requests/${leaveRequestId}/decide`).send({
      decision: "approved",
      decisionNotes: "Enjoy",
    });
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.data.status).toBe("approved");

    const balAfterApprove = await schoolA.agent.get(`/api/leave-balances?staffId=${staffId}`);
    expect(balAfterApprove.body.data[0].id).toBe(balId);
    expect(Number(balAfterApprove.body.data[0].used)).toBe(2);

    // Cancel restores deducted balance
    const cancelRes = await schoolA.agent.post(`/api/leave-requests/${leaveRequestId}/cancel`);
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.data.status).toBe("cancelled");

    const balAfterCancel = await schoolA.agent.get(`/api/leave-balances?staffId=${staffId}`);
    expect(Number(balAfterCancel.body.data[0].used)).toBe(0);

    // Student leave request (no leaveTypeId) works
    const slr = await schoolA.agent.post("/api/leave-requests").send({
      studentId,
      fromDate: "2026-09-14",
      toDate: "2026-09-14",
      days: 1,
      durationType: "full_day",
      reason: "Doctor appointment",
    });
    expect(slr.status).toBe(201);
  });
});

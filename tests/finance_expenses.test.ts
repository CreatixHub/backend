import { describe, expect, it } from "vitest";
import { signupAndLogin, uniqueSlug } from "./helpers";

async function setupSchool(tag: string) {
  const ctx = await signupAndLogin(tag);
  const slug = uniqueSlug(tag);
  const orgRes = await ctx.agent.post("/api/organizations").send({ name: `${tag} School`, slug });
  expect(orgRes.status).toBe(201);
  await ctx.switchOrganization(slug);
  return { ...ctx, slug };
}

describe("Task 2 — Fees & Expenses", () => {
  it("handles fee structures, invoices, idempotent payments, and expense approval/payment", async () => {
    const schoolA = await setupSchool("fin-a");
    const schoolB = await setupSchool("fin-b");

    // 1. Class + Student + Staff in School A
    const clsRes = await schoolA.agent.post("/api/classes").send({
      gradeLevel: 10,
      name: "Grade 10",
      code: "G10",
      displayOrder: 1,
    });
    expect(clsRes.status).toBe(201);
    const classId = clsRes.body.data.id as string;

    const studentRes = await schoolA.agent.post("/api/students").send({
      firstName: "Diya",
      lastName: "Sharma",
      dob: "2012-03-10",
      admittedOn: "2026-06-01",
    });
    expect(studentRes.status).toBe(201);
    const studentId = studentRes.body.data.id as string;

    const staffRes = await schoolA.agent.post("/api/staff").send({
      staffType: "non_teaching",
      employmentType: "full_time",
      firstName: "Vikram",
      joinedOn: "2026-06-01",
    });
    expect(staffRes.status).toBe(201);
    const staffId = staffRes.body.data.id as string;

    // 2. Fee Group + Fee Type
    const fgRes = await schoolA.agent.post("/api/fee-groups").send({
      name: "Academic Tuition",
      code: "TUIT",
      category: "tuition",
      displayOrder: 1,
    });
    expect(fgRes.status).toBe(201);

    const ftRes = await schoolA.agent.post("/api/fee-types").send({
      feeGroupId: fgRes.body.data.id,
      code: "TF01",
      name: "Tuition Fee",
      category: "tuition",
      frequency: "annual",
      defaultAmount: 20000,
    });
    expect(ftRes.status).toBe(201);
    const feeTypeId = ftRes.body.data.id as string;

    // 3. Fee Structure with items & installments
    const fsRes = await schoolA.agent.post("/api/fee-structures").send({
      academicYearId: "1",
      classId,
      name: "Grade 10 Annual Plan",
      code: "G10-ANN",
      frequency: "annual",
      items: [{ feeTypeId, amount: 20000, isOptional: false, dueOn: "2026-07-01" }],
      installments: [
        { name: "Term 1", sequence: 1, dueOn: "2026-07-01", percentOfTotal: 50 },
        { name: "Term 2", sequence: 2, dueOn: "2026-12-01", percentOfTotal: 50 },
      ],
    });
    expect(fsRes.status).toBe(201);
    expect(fsRes.body.data.items).toHaveLength(1);
    expect(fsRes.body.data.installments).toHaveLength(2);
    const feeStructureId = fsRes.body.data.id as string;
    const installmentId = fsRes.body.data.installments[0].id as string;

    // 4. Fee Assignment
    const faRes = await schoolA.agent.post("/api/fee-assignments").send({
      enrollmentId: "8001",
      feeStructureId,
      assignedOn: "2026-06-15",
      discountPercent: 10,
    });
    expect(faRes.status).toBe(201);

    // 5. Generate Invoice from Structure (50% installment = 10000, minus 10% discount = 9000)
    const genInv = await schoolA.agent.post("/api/invoices/generate-from-structure").send({
      studentId,
      enrollmentId: "8001",
      academicYearId: "1",
      feeStructureId,
      installmentId,
      issuedOn: "2026-06-20",
      dueOn: "2026-07-01",
      discountPercent: 10,
      status: "issued",
    });
    expect(genInv.status).toBe(201);
    expect(genInv.body.data.totalAmount).toBe("9000.00");
    const invoiceId = genInv.body.data.id as string;

    // School B cannot access School A's invoice
    const crossInv = await schoolB.agent.get(`/api/invoices/${invoiceId}`);
    expect(crossInv.status).toBe(404);

    // 6. Idempotent Payments
    const pay1 = await schoolA.agent.post("/api/payments").send({
      studentId,
      amount: 9000,
      method: "upi",
      idempotencyKey: "pay-key-12345",
    });
    expect(pay1.status).toBe(201);

    const payReplay = await schoolA.agent.post("/api/payments").send({
      studentId,
      amount: 9000,
      method: "upi",
      idempotencyKey: "pay-key-12345",
    });
    expect(payReplay.status).toBe(200);
    expect(payReplay.body.data.id).toBe(pay1.body.data.id);
    expect(payReplay.body.data.receiptNo).toBe(pay1.body.data.receiptNo);

    // 7. Expense Categories & Expenses Workflow
    const ecRes = await schoolA.agent.post("/api/expense-categories").send({
      name: "Utilities",
      annualBudget: 100000,
      perExpenseLimit: 15000,
      approvalLevel: "admin",
      isActive: true,
    });
    expect(ecRes.status).toBe(201);
    const categoryId = ecRes.body.data.id as string;

    // Exceeds perExpenseLimit -> 400
    const overLimit = await schoolA.agent.post("/api/expenses").send({
      categoryId,
      staffId,
      priority: "normal",
      amount: 16000,
      taxAmount: 0,
      expenseDate: "2026-08-01",
      description: "Transformer replacement",
    });
    expect(overLimit.status).toBe(400);

    // Valid expense -> approve -> mark paid
    const expRes = await schoolA.agent.post("/api/expenses").send({
      categoryId,
      staffId,
      priority: "high",
      amount: 5000,
      taxAmount: 900,
      expenseDate: "2026-08-02",
      description: "Electricity bill",
      paymentMethod: "bank_transfer",
    });
    expect(expRes.status).toBe(201);
    expect(expRes.body.data.status).toBe("submitted");
    const expenseId = expRes.body.data.id as string;

    const appExp = await schoolA.agent.post(`/api/expenses/${expenseId}/decide`).send({ decision: "approved" });
    expect(appExp.status).toBe(200);
    expect(appExp.body.data.status).toBe("approved");

    const paidExp = await schoolA.agent.post(`/api/expenses/${expenseId}/mark-paid`).send({});
    expect(paidExp.status).toBe(200);
    expect(paidExp.body.data.status).toBe("paid");
    expect(paidExp.body.data.paidAt).toBeTruthy();

    // Cannot delete paid expense
    const delPaid = await schoolA.agent.delete(`/api/expenses/${expenseId}`);
    expect(delPaid.status).toBe(409);
  });
});

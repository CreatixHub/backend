import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { payments } from '../../db/schema';
import { HttpError } from '../../lib/errors';
import { isUniqueViolation } from '../../lib/pgErrors';
import { created, ok } from '../../lib/respond';
import { currentTenant, currentUser } from '../../middleware/authenticate';
import { ledger, myStudent, syncInvoiceStatuses } from '../feeCollection/feeStudent.service';
import { notifyUsers } from '../notifications/notifications.service';

export const razorpayRouter = Router();

function keys() {
  const id = process.env.RAZORPAY_KEY_ID?.trim();
  const secret = process.env.RAZORPAY_KEY_SECRET?.trim();
  if (!id || !secret) throw new HttpError(400, 'Online payment is not set up yet. Please pay at the school office.');
  if (process.env.NODE_ENV !== 'production' && !id.startsWith('rzp_test_')) {
    throw new HttpError(400, 'Use Razorpay TEST keys (rzp_test_...) while testing.');
  }
  return { id, secret };
}

async function rz<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const { id, secret } = keys();
  const r = await fetch(`https://api.razorpay.com/v1${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
      'Content-Type': 'application/json',
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError(502, data?.error?.description ?? 'Razorpay request failed');
  return data as T;
}

const money = (n: number) => Number(n.toFixed(2));

// 1) create an order for what the signed-in student owes (the amount is checked here, not trusted from the app)
const orderSchema = z.object({ amount: z.coerce.number().positive().max(10_000_000).optional() }).strict();

razorpayRouter.post('/order', async (req, res) => {
  const tenant = currentTenant(req);
  const user = currentUser(req);
  const body = orderSchema.parse(req.body ?? {});
  const me = await myStudent(tenant, user);
  const l = await ledger(tenant.id, me.id);
  const payable = Math.max(money(l.balance - l.pending), 0);
  if (payable <= 0) throw new HttpError(400, 'You have no fees due right now');
  const amount = money(body.amount ?? payable);
  if (amount > payable + 0.001) throw new HttpError(400, `The amount cannot be more than the fees due (${payable.toFixed(2)})`);
  const paise = Math.round(amount * 100);
  if (paise < 100) throw new HttpError(400, 'The minimum online payment is Rs 1');

  const order = await rz<{ id: string; amount: number; currency: string }>('/orders', {
    method: 'POST',
    body: {
      amount: paise,
      currency: 'INR',
      receipt: `fee-${me.id}-${Date.now()}`.slice(0, 40),
      notes: { studentId: String(me.id), tenantId: String(tenant.id) },
    },
  });
  created(res, {
    orderId: order.id,
    amount: order.amount,
    currency: order.currency,
    keyId: keys().id,
    studentName: me.fullName || me.firstName || 'Student',
    description: `School fees - Adm ${me.admissionNo}`,
  });
});

// 2) verify the payment, then record it as a cleared payment
const verifySchema = z
  .object({
    razorpay_order_id: z.string().min(5).max(64),
    razorpay_payment_id: z.string().min(5).max(64),
    razorpay_signature: z.string().min(10).max(200),
  })
  .strict();

razorpayRouter.post('/verify', async (req, res) => {
  const tenant = currentTenant(req);
  const user = currentUser(req);
  const b = verifySchema.parse(req.body);
  const me = await myStudent(tenant, user);
  const { secret } = keys();

  const expected = crypto.createHmac('sha256', secret).update(`${b.razorpay_order_id}|${b.razorpay_payment_id}`).digest('hex');
  const a = Buffer.from(expected);
  const c = Buffer.from(b.razorpay_signature);
  if (a.length !== c.length || !crypto.timingSafeEqual(a, c)) throw new HttpError(400, 'Payment could not be verified');

  const [done] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.tenantId, tenant.id), eq(payments.idempotencyKey, b.razorpay_order_id)))
    .limit(1);
  if (done) return ok(res, { receiptNo: done.receiptNo, amount: money(Number(done.amount)), status: done.status, replayed: true });

  const order = await rz<any>(`/orders/${b.razorpay_order_id}`);
  if (order.notes?.studentId !== String(me.id) || order.notes?.tenantId !== String(tenant.id)) {
    throw new HttpError(403, 'This payment does not belong to you');
  }
  let pay = await rz<any>(`/payments/${b.razorpay_payment_id}`);
  if (pay.order_id !== b.razorpay_order_id) throw new HttpError(400, 'Payment does not match the order');
  if (pay.status === 'authorized') {
    pay = await rz<any>(`/payments/${b.razorpay_payment_id}/capture`, {
      method: 'POST',
      body: { amount: pay.amount, currency: pay.currency },
    });
  }
  if (pay.status !== 'captured') throw new HttpError(400, 'The payment was not completed');

  const amount = money(Number(pay.amount) / 100);
  try {
    const [row] = await db
      .insert(payments)
      .values({
        tenantId: tenant.id,
        receiptNo: `RCP-${new Date().getFullYear()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`,
        studentId: me.id,
        amount: amount.toFixed(2),
        method: 'online',
        receivedAt: new Date(),
        receivedBy: user.id,
        status: 'cleared',
        idempotencyKey: b.razorpay_order_id,
        referenceNo: b.razorpay_payment_id,
      })
      .returning();
    await syncInvoiceStatuses(tenant.id, me.id);
    await notifyUsers(tenant.id, [
      {
        userId: user.id,
        type: 'fee_payment_approved',
        title: 'Payment received',
        body: `Your fee payment of Rs ${amount.toFixed(2)} (receipt ${row.receiptNo}) was received. Thank you.`,
        data: { paymentId: String(row.id), status: 'cleared' },
      },
    ]);
    ok(res, { receiptNo: row.receiptNo, amount, status: row.status, replayed: false });
  } catch (e) {
    if (isUniqueViolation(e)) return ok(res, { receiptNo: null, amount, status: 'cleared', replayed: true });
    throw e;
  }
});
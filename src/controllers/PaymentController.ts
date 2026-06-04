import { Request, Response, NextFunction } from 'express';
import { PaymentService } from '../services/PaymentService';
import { RefundService } from '../services/RefundService';
import { TransactionService } from '../services/TransactionService';
import { ApiResponse } from '../types';

const paymentService = new PaymentService();
const refundService = new RefundService();
const transactionService = new TransactionService();

// ── Payments ──────────────────────────────────────────────────────────────────

export async function createPayment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const payment = await paymentService.createPayment(req.body);
    const response: ApiResponse = { success: true, data: payment };
    res.status(201).json(response);
  } catch (err) {
    next(err);
  }
}

export async function getPayment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const payment = await paymentService.getPaymentById(req.params.paymentId);
    res.json({ success: true, data: payment } as ApiResponse);
  } catch (err) {
    next(err);
  }
}

export async function listPayments(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await paymentService.listPayments({
      ...req.query,
      merchantId: req.auth?.merchantId,
    } as any);
    res.json({ success: true, data: result.data, meta: {
      total: result.total,
      page: result.page,
      limit: result.limit,
      totalPages: result.totalPages,
      hasNext: result.hasNext,
      hasPrev: result.hasPrev,
    }} as ApiResponse);
  } catch (err) {
    next(err);
  }
}

export async function capturePayment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const payment = await paymentService.capturePayment({
      paymentId: req.params.paymentId,
      ...req.body,
    });
    res.json({ success: true, data: payment } as ApiResponse);
  } catch (err) {
    next(err);
  }
}

export async function cancelPayment(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const payment = await paymentService.cancelPayment(req.params.paymentId);
    res.json({ success: true, data: payment } as ApiResponse);
  } catch (err) {
    next(err);
  }
}

// ── Refunds ───────────────────────────────────────────────────────────────────

export async function createRefund(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const refund = await refundService.createRefund({
      ...req.body,
      initiatedBy: req.auth?.sub ?? 'system',
    });
    res.status(201).json({ success: true, data: refund } as ApiResponse);
  } catch (err) {
    next(err);
  }
}

export async function getRefund(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const refund = await refundService.getRefundById(req.params.refundId);
    res.json({ success: true, data: refund } as ApiResponse);
  } catch (err) {
    next(err);
  }
}

export async function listRefunds(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const refunds = await refundService.listRefundsByPayment(req.params.paymentId);
    res.json({ success: true, data: refunds } as ApiResponse);
  } catch (err) {
    next(err);
  }
}

// ── Transactions ──────────────────────────────────────────────────────────────

export async function listTransactions(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const transactions = await transactionService.listTransactionsByPayment(req.params.paymentId);
    res.json({ success: true, data: transactions } as ApiResponse);
  } catch (err) {
    next(err);
  }
}

export async function getPaymentSummary(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { merchantId } = req.params;
    const { fromDate, toDate } = req.query as { fromDate: string; toDate: string };
    const summary = await transactionService.getPaymentSummary(
      merchantId,
      new Date(fromDate),
      new Date(toDate),
    );
    res.json({ success: true, data: summary } as ApiResponse);
  } catch (err) {
    next(err);
  }
}

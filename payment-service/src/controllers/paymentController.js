const crypto = require("crypto");
const Razorpay = require("razorpay");
const Payment = require("../models/Payment");
const { bookingClient, internalHeaders, notificationClient } = require("../config/http");
const { uploadPaymentInvoice } = require("../config/invoiceStorage");
const { publishInvoice, publishNotification } = require("../services/sqsPublisher");

const buildPaymentId = () => `PAY-${Date.now()}${Math.floor(Math.random() * 1000)}`;
const buildTransactionRef = () => `TXN-${Date.now()}${Math.floor(Math.random() * 10000)}`;
const DEFAULT_BOOKING_AMOUNT = 50;

const getAffordableAmount = (amount) => {
  const numericAmount = Number(amount);
  return Number.isFinite(numericAmount) && numericAmount > 0 ? numericAmount : DEFAULT_BOOKING_AMOUNT;
};

const getRazorpayClient = () => {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    throw new Error("Razorpay credentials are not configured");
  }

  return new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET,
  });
};

const sendNotification = async ({ recipientUserId, bookingId, type, message, metadata = {} }) => {
  const payload = { recipientUserId, bookingId, type, message, channel: "console", metadata };
  try {
    if (await publishNotification(payload)) {
      return;
    }
    await notificationClient.post(
      "/internal/notify",
      payload,
      { headers: internalHeaders() }
    );
  } catch (error) {
    console.error("SQS notification publish failed; using HTTP fallback", error.message);
    try {
      await notificationClient.post("/internal/notify", payload, { headers: internalHeaders() });
    } catch (fallbackError) {
      console.error("Payment notification fallback failed", fallbackError.response?.data || fallbackError.message);
    }
  }
};

const attachInvoice = async ({ payment, booking, provider }) => {
  try {
    if (await publishInvoice({ payment, booking, provider })) {
      return { ...payment, invoiceStatus: "pending" };
    }
  } catch (error) {
    console.error("SQS invoice publish failed; using inline fallback", error.message);
  }

  try {
    const invoiceFields = await uploadPaymentInvoice({ payment, booking, provider });
    if (!invoiceFields) {
      return payment;
    }
    return Payment.updatePayment(payment.paymentId, invoiceFields);
  } catch (error) {
    console.error("Payment invoice inline upload failed", error.message);
    return payment;
  }
};

const processPayment = async (req, res) => {
  try {
    const { bookingId, method = "card", simulateSuccess = true } = req.body;
    if (!bookingId) {
      return res.status(400).json({ message: "bookingId is required" });
    }

    const bookingResponse = await bookingClient.get(`/internal/bookings/${bookingId}`, {
      headers: internalHeaders(),
    });
    const booking = bookingResponse.data;

    if (req.user.role !== "admin" && booking.userId !== req.user.id) {
      return res.status(403).json({ message: "Access denied for this booking" });
    }
    if (booking.status !== "pending") {
      return res.status(400).json({ message: `Cannot pay for a ${booking.status} booking` });
    }

    const payableAmount = getAffordableAmount(booking.amount);

    const payment = await Payment.createPayment({
      paymentId: buildPaymentId(),
      bookingId,
      userId: booking.userId,
      amount: payableAmount,
      method,
      status: simulateSuccess ? "success" : "failed",
      transactionRef: buildTransactionRef(),
    });

    if (simulateSuccess) {
      const confirmResponse = await bookingClient.post(
        `/internal/bookings/${bookingId}/confirm`,
        {},
        { headers: internalHeaders() }
      );
      const paymentWithInvoice = await attachInvoice({
        payment,
        booking: confirmResponse.data.booking,
        provider: "simulated",
      });
      await sendNotification({
        recipientUserId: booking.userId,
        bookingId,
        type: "payment_success",
        message: `Payment successful for booking ${bookingId}.`,
        metadata: { amount: payableAmount, method, paymentId: paymentWithInvoice.paymentId },
      });
      return res.json({
        message: "Payment successful",
        payment: paymentWithInvoice,
        booking: confirmResponse.data.booking,
      });
    }

    const cancelResponse = await bookingClient.post(
      `/internal/bookings/${bookingId}/cancel`,
      {},
      { headers: internalHeaders() }
    );
    await sendNotification({
      recipientUserId: booking.userId,
      bookingId,
      type: "payment_failed",
      message: `Payment failed for booking ${bookingId}.`,
      metadata: { amount: payableAmount, method, paymentId: payment.paymentId },
    });

    return res.status(400).json({
      message: "Payment failed",
      payment,
      booking: cancelResponse.data.booking,
    });
  } catch (error) {
    return res.status(500).json({
      message: "Payment processing failed",
      error: error.response?.data?.message || error.message,
    });
  }
};

const getPayableBooking = async (req, bookingId) => {
  if (!bookingId) {
    const error = new Error("bookingId is required");
    error.statusCode = 400;
    throw error;
  }

  const bookingResponse = await bookingClient.get(`/internal/bookings/${bookingId}`, {
    headers: internalHeaders(),
  });
  const booking = bookingResponse.data;

  if (req.user.role !== "admin" && booking.userId !== req.user.id) {
    const error = new Error("Access denied for this booking");
    error.statusCode = 403;
    throw error;
  }

  if (booking.status !== "pending") {
    const error = new Error(`Cannot pay for a ${booking.status} booking`);
    error.statusCode = 400;
    throw error;
  }

  return booking;
};

const createRazorpayOrder = async (req, res) => {
  try {
    const { bookingId } = req.body;
    const booking = await getPayableBooking(req, bookingId);
    const payableAmount = getAffordableAmount(booking.amount);
    const amountInPaise = Math.round(payableAmount * 100);

    if (!Number.isInteger(amountInPaise) || amountInPaise <= 0) {
      return res.status(400).json({ message: "Booking amount is invalid" });
    }

    const existingPayment = await Payment.findReusableOrderPayment({
      bookingId,
      userId: booking.userId,
    });

    if (existingPayment) {
      return res.status(200).json({
        keyId: process.env.RAZORPAY_KEY_ID,
        order: {
          id: existingPayment.razorpayOrderId,
          amount: amountInPaise,
          currency: process.env.RAZORPAY_CURRENCY || "INR",
          receipt: existingPayment.paymentId,
        },
        booking,
      });
    }

    const razorpay = getRazorpayClient();
    const order = await razorpay.orders.create({
      amount: amountInPaise,
      currency: process.env.RAZORPAY_CURRENCY || "INR",
      receipt: buildPaymentId(),
      notes: {
        bookingId,
        userId: booking.userId,
      },
    });

    await Payment.createPayment({
      paymentId: order.receipt,
      bookingId,
      userId: booking.userId,
      amount: payableAmount,
      method: "razorpay",
      status: "created",
      transactionRef: order.id,
      razorpayOrderId: order.id,
    });

    return res.status(201).json({
      keyId: process.env.RAZORPAY_KEY_ID,
      order,
      booking,
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      message: "Failed to create Razorpay order",
      error: error.response?.data?.message || error.message,
    });
  }
};

const verifyRazorpayPayment = async (req, res) => {
  try {
    const { bookingId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    const booking = await getPayableBooking(req, bookingId);

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ message: "Razorpay payment details are required" });
    }

    const payment = await Payment.findPaymentByRazorpayOrder({
      bookingId,
      userId: booking.userId,
      razorpayOrderId: razorpay_order_id,
    });

    if (!payment) {
      return res.status(404).json({ message: "Payment order not found" });
    }

    const payableAmount = getAffordableAmount(payment.amount ?? booking.amount);

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      const failedPayment = await Payment.updatePayment(payment.paymentId, {
        status: "failed",
        razorpayPaymentId: razorpay_payment_id,
        razorpaySignature: razorpay_signature,
      });
      return res.status(400).json({ message: "Payment verification failed", payment: failedPayment });
    }

    const updatedPayment = await Payment.updatePayment(payment.paymentId, {
      status: "success",
      transactionRef: razorpay_payment_id,
      razorpayPaymentId: razorpay_payment_id,
      razorpaySignature: razorpay_signature,
    });

    const confirmResponse = await bookingClient.post(
      `/internal/bookings/${bookingId}/confirm`,
      {},
      { headers: internalHeaders() }
    );

    const paymentWithInvoice = await attachInvoice({
      payment: updatedPayment,
      booking: confirmResponse.data.booking,
      provider: "razorpay",
    });

    await sendNotification({
      recipientUserId: booking.userId,
      bookingId,
      type: "payment_success",
      message: `Payment successful for booking ${bookingId}.`,
      metadata: {
        amount: payableAmount,
        method: "razorpay",
        paymentId: paymentWithInvoice.paymentId,
        razorpayPaymentId: razorpay_payment_id,
      },
    });

    return res.json({
      message: "Payment verified",
      payment: paymentWithInvoice,
      booking: confirmResponse.data.booking,
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({
      message: "Payment verification failed",
      error: error.response?.data?.message || error.message,
    });
  }
};

const getPayments = async (req, res) => {
  try {
    const payments = await Payment.listPayments({
      isAdmin: req.user.role === "admin",
      userId: req.user.id,
    });
    return res.json(payments);
  } catch (error) {
    return res.status(500).json({ message: "Failed to load payments", error: error.message });
  }
};

module.exports = { createRazorpayOrder, getPayments, processPayment, verifyRazorpayPayment };

const express = require("express");
const {
  createRazorpayOrder,
  getPayments,
  processPayment,
  verifyRazorpayPayment,
} = require("../controllers/paymentController");
const { authenticate } = require("../middleware/auth");

const router = express.Router();

router.get("/health", (_req, res) => res.json({ service: "payment-service", status: "ok" }));
router.post("/payments/razorpay/order", authenticate, createRazorpayOrder);
router.post("/payments/razorpay/verify", authenticate, verifyRazorpayPayment);
router.post("/payments/process", authenticate, processPayment);
router.get("/payments", authenticate, getPayments);

module.exports = router;


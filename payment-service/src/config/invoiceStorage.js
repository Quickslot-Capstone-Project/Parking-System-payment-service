const { PutObjectCommand, S3Client } = require("@aws-sdk/client-s3");
const PDFDocument = require("pdfkit");

const region = process.env.AWS_REGION || "us-east-1";
const bucketName = process.env.PAYMENT_INVOICE_BUCKET;
const kmsKeyArn = process.env.PAYMENT_INVOICE_KMS_KEY_ARN;

const s3Client = new S3Client({ region });

const buildInvoiceKey = ({ paymentId, bookingId }) => {
  const safeBookingId = String(bookingId || "unknown").replace(/[^A-Za-z0-9._-]/g, "-");
  const safePaymentId = String(paymentId || Date.now()).replace(/[^A-Za-z0-9._-]/g, "-");
  const datePrefix = new Date().toISOString().slice(0, 10);
  return `payment-invoices/${datePrefix}/${safeBookingId}/${safePaymentId}.pdf`;
};

const addDetail = (doc, label, value) => {
  doc.font("Helvetica-Bold").text(`${label}: `, { continued: true });
  doc.font("Helvetica").text(value == null || value === "" ? "N/A" : String(value));
};

const buildInvoicePdf = ({ invoice, payment, booking }) =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks = [];

    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.font("Helvetica-Bold").fontSize(22).text("Quickslot Payment Invoice");
    doc.moveDown(0.5);
    doc.font("Helvetica").fontSize(10).text("Quickslot");
    doc.moveDown(1.5);

    doc.fontSize(12);
    addDetail(doc, "Invoice ID", invoice.invoiceId);
    addDetail(doc, "Generated At", invoice.createdAt);
    addDetail(doc, "Payment Provider", invoice.provider);

    doc.moveDown();
    doc.font("Helvetica-Bold").fontSize(15).text("Payment Details");
    doc.moveDown(0.4);
    doc.fontSize(12);
    addDetail(doc, "Payment ID", payment.paymentId);
    addDetail(doc, "Booking ID", payment.bookingId);
    addDetail(doc, "User ID", payment.userId);
    addDetail(doc, "Amount", payment.amount);
    addDetail(doc, "Method", payment.method);
    addDetail(doc, "Status", payment.status);
    addDetail(doc, "Transaction Ref", payment.transactionRef);
    addDetail(doc, "Razorpay Order ID", payment.razorpayOrderId);
    addDetail(doc, "Razorpay Payment ID", payment.razorpayPaymentId);

    doc.moveDown();
    doc.font("Helvetica-Bold").fontSize(15).text("Booking Details");
    doc.moveDown(0.4);
    doc.fontSize(12);
    addDetail(doc, "Slot ID", booking.slotId);
    addDetail(doc, "User Email", booking.userEmail);
    addDetail(doc, "Booking Status", booking.status);
    addDetail(doc, "Paid At", booking.paidAt);

    doc.moveDown(2);
    doc.font("Helvetica").fontSize(10).text("This invoice was generated automatically by Quickslot.", {
      align: "center",
    });

    doc.end();
  });

const uploadPaymentInvoice = async ({ payment, booking, provider = "razorpay" }) => {
  if (!bucketName) {
    console.warn("Payment invoice upload skipped: PAYMENT_INVOICE_BUCKET is not configured");
    return null;
  }

  const createdAt = new Date().toISOString();
  const key = buildInvoiceKey({
    paymentId: payment.paymentId,
    bookingId: payment.bookingId,
  });
  const invoice = {
    invoiceId: `INV-${payment.paymentId}`,
    createdAt,
    provider,
  };
  const pdfBody = await buildInvoicePdf({ invoice, payment, booking });

  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: pdfBody,
    ContentType: "application/pdf",
    ServerSideEncryption: "aws:kms",
    SSEKMSKeyId: kmsKeyArn,
    Metadata: {
      invoiceId: invoice.invoiceId,
      paymentId: String(payment.paymentId),
      bookingId: String(payment.bookingId),
      userId: String(payment.userId),
      email: String(booking.userEmail || payment.userEmail || payment.userId || ""),
    },
  });

  await s3Client.send(command);
  console.log(`Payment invoice uploaded to s3://${bucketName}/${key}`);

  return {
    invoiceS3Bucket: bucketName,
    invoiceS3Key: key,
    invoiceKmsKeyArn: kmsKeyArn,
    invoiceCreatedAt: createdAt,
  };
};

module.exports = { uploadPaymentInvoice };

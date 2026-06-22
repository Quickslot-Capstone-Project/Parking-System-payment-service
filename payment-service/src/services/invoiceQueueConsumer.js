const { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } = require("@aws-sdk/client-sqs");
const Payment = require("../models/Payment");
const { uploadPaymentInvoice } = require("../config/invoiceStorage");

const client = new SQSClient({ region: process.env.AWS_REGION || "us-east-1" });
let running = false;

const handleMessage = async (message) => {
  const event = JSON.parse(message.Body);
  if (event.eventType !== "invoice.generate" || !event.payload?.payment || !event.payload?.booking) {
    throw new Error("Unsupported or incomplete invoice event");
  }
  const invoiceFields = await uploadPaymentInvoice(event.payload);
  if (invoiceFields) {
    await Payment.updatePayment(event.payload.payment.paymentId, {
      ...invoiceFields,
      invoiceStatus: "available",
      invoiceSourceEventId: event.eventId,
    });
  }
};

const startInvoiceQueueConsumer = () => {
  const queueUrl = process.env.INVOICE_QUEUE_URL;
  if (String(process.env.SQS_ENABLED).toLowerCase() !== "true" || !queueUrl || running) {
    return;
  }
  running = true;
  console.log("Invoice SQS consumer started");

  const poll = async () => {
    while (running) {
      try {
        const response = await client.send(new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 5,
          WaitTimeSeconds: 20,
          VisibilityTimeout: 120,
        }));
        for (const message of response.Messages || []) {
          try {
            await handleMessage(message);
            await client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
          } catch (error) {
            console.error("Invoice SQS message failed", error.message);
          }
        }
      } catch (error) {
        console.error("Invoice SQS polling failed", error.message);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  };
  poll();
};

module.exports = { startInvoiceQueueConsumer };

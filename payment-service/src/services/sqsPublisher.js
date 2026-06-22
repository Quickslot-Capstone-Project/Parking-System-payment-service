const crypto = require("crypto");
const { SendMessageCommand, SQSClient } = require("@aws-sdk/client-sqs");

const client = new SQSClient({ region: process.env.AWS_REGION || "us-east-1" });
const sqsEnabled = () => String(process.env.SQS_ENABLED).toLowerCase() === "true";

const publish = async (queueUrl, eventType, payload) => {
  if (!sqsEnabled() || !queueUrl) {
    return false;
  }
  await client.send(new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify({
      eventId: crypto.randomUUID(),
      eventType,
      environment: process.env.APP_ENV || "dev",
      timestamp: new Date().toISOString(),
      payload,
    }),
  }));
  return true;
};

const publishNotification = (payload) =>
  publish(process.env.NOTIFICATION_QUEUE_URL, "notification.requested", payload);

const publishInvoice = (payload) =>
  publish(process.env.INVOICE_QUEUE_URL, "invoice.generate", payload);

module.exports = { publishInvoice, publishNotification };


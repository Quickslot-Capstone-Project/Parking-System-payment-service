const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} = require("@aws-sdk/lib-dynamodb");

const tableName = process.env.PAYMENT_TABLE || "smart-parking-payments";
const client = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: process.env.AWS_REGION || "us-east-1" }),
  { marshallOptions: { removeUndefinedValues: true } }
);

const scanAll = async () => {
  const items = [];
  let ExclusiveStartKey;

  do {
    const response = await client.send(
      new ScanCommand({
        TableName: tableName,
        ExclusiveStartKey,
      })
    );
    items.push(...(response.Items || []));
    ExclusiveStartKey = response.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  return items;
};

const sortNewest = (items) =>
  [...items].sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));

const createPayment = async (payment) => {
  const now = new Date().toISOString();
  const item = { ...payment, createdAt: now, updatedAt: now };

  await client.send(
    new PutCommand({
      TableName: tableName,
      Item: item,
      ConditionExpression: "attribute_not_exists(paymentId)",
    })
  );

  return item;
};

const listPayments = async ({ userId, isAdmin }) => {
  const payments = await scanAll();
  return sortNewest(isAdmin ? payments : payments.filter((payment) => payment.userId === userId));
};

const findReusableOrderPayment = async ({ bookingId, userId }) => {
  const payments = await scanAll();
  return sortNewest(
    payments.filter(
      (payment) =>
        payment.bookingId === bookingId &&
        payment.userId === userId &&
        payment.status === "created" &&
        payment.razorpayOrderId &&
        Number(payment.amount) > 0
    )
  )[0] || null;
};

const findPaymentByRazorpayOrder = async ({ bookingId, userId, razorpayOrderId }) => {
  const payments = await scanAll();
  return sortNewest(
    payments.filter(
      (payment) =>
        payment.bookingId === bookingId &&
        payment.userId === userId &&
        payment.razorpayOrderId === razorpayOrderId
    )
  )[0] || null;
};

const updatePayment = async (paymentId, fields) => {
  const values = { ...fields, updatedAt: new Date().toISOString() };
  const names = {};
  const expressionValues = {};
  const setExpressions = [];

  Object.entries(values).forEach(([key, value]) => {
    names[`#${key}`] = key;
    expressionValues[`:${key}`] = value;
    setExpressions.push(`#${key} = :${key}`);
  });

  const response = await client.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { paymentId },
      UpdateExpression: `SET ${setExpressions.join(", ")}`,
      ConditionExpression: "attribute_exists(paymentId)",
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: expressionValues,
      ReturnValues: "ALL_NEW",
    })
  );

  return response.Attributes;
};

module.exports = {
  createPayment,
  findPaymentByRazorpayOrder,
  findReusableOrderPayment,
  listPayments,
  updatePayment,
};

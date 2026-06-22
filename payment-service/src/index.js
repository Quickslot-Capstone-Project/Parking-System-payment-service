require("dotenv").config();
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const paymentRoutes = require("./routes/paymentRoutes");
const { startInvoiceQueueConsumer } = require("./services/invoiceQueueConsumer");

const app = express();

app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json());
app.use(morgan("dev"));
app.use("/", paymentRoutes);

const start = async () => {
  try {
    const port = process.env.PORT || 4004;
    app.listen(port, () => {
      console.log(`Payment service listening on port ${port}`);
    });
    startInvoiceQueueConsumer();
  } catch (error) {
    console.error("Payment service failed to start", error);
    process.exit(1);
  }
};

start();


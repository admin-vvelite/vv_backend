const express = require("express");

const cors = require("cors");
const app = express();
require("dotenv").config();

const home_routes = require("../routes/home_routes");
const odoo_routes = require("../routes/odoo_routes");
const myFatoorah_routes = require("../routes/myFatoorah_routes");

// Use CORS once with options
app.use(
  cors({
    origin: "*", // Allow all origins (adjust for production)
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true,
  }),
);

// Replace app.use(express.json()); with this:
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf; // This captures the exact string sent by myFatoorah
    },
  }),
);
app.use("/api/v1/home", home_routes);
app.use("/api/v1/odoo", odoo_routes);
app.use("/api/v1/myfatoorah", myFatoorah_routes);

app.get("/", (req, res) => {
  res.send("Server is running. Go to /data to see the API.");
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = app;

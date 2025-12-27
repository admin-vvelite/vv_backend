const express = require("express");
const cors = require("cors");
const app = express();
const home_routes = require("../routes/home_routes");
const odoo_routes = require("../routes/odoo_routes");

require("dotenv").config();

// Use CORS once with options
app.use(
  cors({
    origin: "*", // Allow all origins (adjust for production)
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true,
  })
);

app.use(express.json());
app.use("/api/v1/home", home_routes);
app.use("/api/v1/odoo", odoo_routes);

app.get("/", (req, res) => {
  res.send("Server is running. Go to /data to see the API.");
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = app;

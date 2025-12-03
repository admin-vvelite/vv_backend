const express = require("express");
const cors = require("cors");
const app = express();

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

app.get("/", (req, res) => {
  res.send("Server is running. Go to /data to see the API.");
});

app.get("/data", async (req, res) => {
  try {
    console.log("Request received");
    // Ensure APP_SCRIPT_API is set in Vercel Environment Variables
    const response = await fetch(process.env.APP_SCRIPT_API);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Only run app.listen locally
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = app;
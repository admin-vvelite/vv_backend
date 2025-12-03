require("dotenv").config();
const express = require("express");
const cors = require("cors"); 
const app = express();

app.use(cors());

app.get("/data", async (req, res) => {
  try {
    console.log("Request received");
    const response = await fetch(
      process.env.APP_SCRIPT_API
    );
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(3000, () => console.log("Proxy running on port 3000"));

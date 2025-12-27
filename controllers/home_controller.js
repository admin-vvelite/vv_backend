const data_controller = async (req, res) => {
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
};

module.exports = { data_controller };

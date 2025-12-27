const express = require("express");
const router = express.Router();
const { data_controller } = require('../controllers/home_controller');

// Changed to GET to match the standard behavior for fetching data
router.get("/data", data_controller);

module.exports = router;
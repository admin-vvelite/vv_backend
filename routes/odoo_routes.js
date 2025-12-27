const express = require("express");
const router = express.Router();
const {invoices_controller} = require('../controllers/odoo_invoices');

router.get("/invoices" , invoices_controller);

module.exports = router;
const express = require("express");
const router = express.Router(); // Note the Capital 'R' and parentheses ()
const { myfatoorah_odoo_controller } = require("../controllers/myFatoorah");

router.post("/", myfatoorah_odoo_controller);

module.exports = router;
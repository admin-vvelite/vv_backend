const crypto = require("crypto");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

/**
 * myFatoorah to Odoo Integration Controller
 * FORCED: Journal 6 | Account 170 (101001)
 * FIXED: Scientific notation in reference + Explicit Account mapping
 */

const jsonRpc = async (service, method, args) => {
  const ODOO_CONFIG = {
    url: process.env.ODOO_URL,
    db: process.env.ODOO_DB,
    username: process.env.ODOO_USER,
    password: process.env.ODOO_PASS,
  };

  const payload = {
    jsonrpc: "2.0",
    method: "call",
    params: { service, method, args },
    id: Math.floor(Math.random() * 1000000),
  };

  const response = await fetch(ODOO_CONFIG.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const result = await response.json();
  if (result.error) {
    throw new Error(`Odoo Error: ${result.error.data.message}`);
  }
  return result.result;
};

const myfatoorah_odoo_controller = async (req, res) => {
  try {
    const { Data, Event } = req.body;

    // 1. V2 Webhook Filter
    if (Event.Name !== "PAYMENT_STATUS_CHANGED" || Data.Invoice.Status !== "PAID") {
      return res.status(200).json({ message: "Event ignored" });
    }

    const dbName = process.env.ODOO_DB;
    const dbUser = process.env.ODOO_USER;
    const dbPass = process.env.ODOO_PASS;

    const uid = await jsonRpc("common", "login", [dbName, dbUser, dbPass]);
    if (!uid) throw new Error("Odoo Authentication Failed");

    // FIX: Convert ID to String immediately to prevent scientific notation (9.933e+22)
    const rawInvoiceId = String(Data.Invoice.Id);
    const mfRef = `MF-${rawInvoiceId}`;

    // 2. Prevent duplicate invoices
    const existingInvoice = await jsonRpc("object", "execute_kw", [
      dbName, uid, dbPass,
      "account.move", "search", [[["ref", "=", mfRef]]],
    ]);

    if (existingInvoice.length > 0) {
      console.log(`⚠️ Duplicate skipped: ${mfRef}`);
      return res.status(200).json({ success: true, message: "Duplicate skipped" });
    }

    // 3. Force USD Currency
    const currencyIds = await jsonRpc("object", "execute_kw", [
      dbName, uid, dbPass,
      "res.currency", "search", [[["name", "=", "USD"]]],
    ]);
    const usdId = currencyIds.length > 0 ? currencyIds[0] : false;

    // 4. Partner Logic
    const email = Data.Customer.Email || `no-email-${rawInvoiceId}@example.com`;
    let partnerId;

    const searchPartner = await jsonRpc("object", "execute_kw", [
      dbName, uid, dbPass,
      "res.partner", "search", [[["email", "=", email]]],
    ]);

    if (searchPartner.length > 0) {
      partnerId = searchPartner[0];
    } else {
      partnerId = await jsonRpc("object", "execute_kw", [
        dbName, uid, dbPass,
        "res.partner", "create",
        [{ 
            name: Data.Customer.Name || "Customer", 
            email: email, 
            phone: Data.Customer.Mobile || "" 
        }],
      ]);
    }

    // 5. Create Draft Invoice
    const invoiceLines = [[0, 0, { 
      name: `Payment for Invoice #${rawInvoiceId}`, 
      quantity: 1, 
      price_unit: parseFloat(Data.Amount.ValueInDisplayCurrency), 
      tax_ids: [[6, 0, []]] 
    }]];

    const invoiceId = await jsonRpc("object", "execute_kw", [
      dbName, uid, dbPass,
      "account.move", "create",
      [{
        move_type: "out_invoice",
        partner_id: partnerId,
        currency_id: usdId,
        invoice_date: new Date().toISOString().split("T")[0],
        ref: mfRef,
        invoice_line_ids: invoiceLines,
      }],
    ]);

    // 6. Post Invoice
    await jsonRpc("object", "execute_kw", [
      dbName, uid, dbPass,
      "account.move", "action_post", [[invoiceId]],
    ]);

    // 7. Get Payment Method Line for Journal 6
    const journalInfo = await jsonRpc("object", "execute_kw", [
      dbName, uid, dbPass,
      "account.journal", "read", [[6], ["inbound_payment_method_line_ids"]]
    ]);
    const methodLineId = journalInfo[0].inbound_payment_method_line_ids[0];

    // 8. Register Payment (Forcing Account 170 via Context)
    const paymentRegisterId = await jsonRpc("object", "execute_kw", [
      dbName, uid, dbPass,
      "account.payment.register", "create",
      [{
        journal_id: 6,
        payment_method_line_id: methodLineId,
        amount: parseFloat(Data.Amount.ValueInDisplayCurrency),
        payment_date: new Date().toISOString().split("T")[0],
        communication: mfRef,
      }],
      {
        context: { 
          active_model: "account.move", 
          active_ids: [invoiceId],
          // FORCE THESE PARAMETERS
          default_journal_id: 6,
          default_account_id: 170, // Force account 101001
          default_payment_type: 'inbound'
        },
      },
    ]);

    // 9. Execute Payment
    await jsonRpc("object", "execute_kw", [
      dbName, uid, dbPass,
      "account.payment.register", "action_create_payments", [[paymentRegisterId]],
    ]);

    console.log(`✅ Success: Registered to Journal 6, Account 170. Ref: ${mfRef}`);
    res.status(200).json({ success: true, odoo_invoice_id: invoiceId });

  } catch (error) {
    console.error("❌ Sync Error:", error.message);
    res.status(500).json({ error: error.message });
  }
};

module.exports = { myfatoorah_odoo_controller };
const crypto = require("crypto");
// Using a dynamic import wrapper to ensure node-fetch works in CommonJS
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

/**
 * myFatoorah to Odoo Integration Controller
 * FIXED: Prevent duplicates + Forced Payment Registration on Account 101007
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

// --- MAIN CONTROLLER ---
const myfatoorah_odoo_controller = async (req, res) => {
  try {
    const { Data, Event } = req.body;

    // 1. Filter for Success Events
    if (Event !== "PAYMENT_STATUS_CHANGED" || Data.InvoiceStatus !== "Paid") {
      return res.status(200).json({ message: "Event ignored" });
    }

    const dbName = process.env.ODOO_DB;
    const dbUser = process.env.ODOO_USER;
    const dbPass = process.env.ODOO_PASS;

    // 2. Odoo Authentication
    const uid = await jsonRpc("common", "login", [dbName, dbUser, dbPass]);
    if (!uid) throw new Error("Odoo Authentication Failed");

    // 3. PREVENTION: Check if invoice already exists (Avoid duplicates 7, 8, 9, 10)
    const existingInvoice = await jsonRpc("object", "execute_kw", [
      dbName, uid, dbPass, "account.move", "search", 
      [[["ref", "=", `MF-${Data.InvoiceId}`]]]
    ]);

    if (existingInvoice.length > 0) {
      console.log(`⚠️ Duplicate detected: Invoice MF-${Data.InvoiceId} already exists.`);
      return res.status(200).json({ success: true, message: "Duplicate invoice skipped" });
    }

    // 4. Force USD Currency ID
    const currencyIds = await jsonRpc("object", "execute_kw", [
      dbName, uid, dbPass, "res.currency", "search", [[["name", "=", "USD"]]]
    ]);
    const usdId = currencyIds.length > 0 ? currencyIds[0] : false;

    // 5. Partner (Customer) Logic
    const email = Data.CustomerEmail;
    let partnerId;
    const searchPartner = await jsonRpc("object", "execute_kw", [
      dbName, uid, dbPass, "res.partner", "search", [[["email", "=", email]]]
    ]);

    if (searchPartner.length > 0) {
      partnerId = searchPartner[0];
    } else {
      partnerId = await jsonRpc("object", "execute_kw", [
        dbName, uid, dbPass, "res.partner", "create",
        [{
          name: Data.CustomerName,
          email: email,
          phone: Data.CustomerMobile || "",
        }],
      ]);
    }

    // 6. Build Invoice Lines
    const invoiceLines = (Data.InvoiceItems || []).map(item => [0, 0, {
      name: item.ItemName,
      quantity: item.Quantity,
      price_unit: item.UnitPrice,
      tax_ids: [[6, 0, []]], // No tax applied as per original
    }]);

    if (Data.DiscountValue > 0) {
      invoiceLines.push([0, 0, {
        name: "Discount Applied",
        quantity: 1,
        price_unit: -parseFloat(Data.DiscountValue),
      }]);
    }

    // 7. Create Draft Invoice
    const invoiceId = await jsonRpc("object", "execute_kw", [
      dbName, uid, dbPass, "account.move", "create",
      [{
        move_type: "out_invoice",
        partner_id: partnerId,
        currency_id: usdId,
        invoice_date: new Date().toISOString().split("T")[0],
        ref: `MF-${Data.InvoiceId}`,
        invoice_line_ids: invoiceLines,
        partner_bank_id: false,
      }],
    ]);

    // 8. STEP 1: Post the Invoice (Entry: Customer Debit / Sales Credit)
    await jsonRpc("object", "execute_kw", [
      dbName, uid, dbPass, "account.move", "action_post", [[invoiceId]]
    ]);

    // 9. STEP 2: Register Payment (Entry: MyFatoorah 101007 Debit / Customer Credit)
    // Find the journal linked to the MyFatoorah account 101007
    const journalSearch = await jsonRpc("object", "execute_kw", [
      dbName, uid, dbPass, "account.journal", "search", 
      [[["default_account_id.code", "=", "101007"]]]
    ]);

    if (journalSearch.length > 0) {
      const journalId = journalSearch[0];

      // Create Payment Register Wizard
      const paymentRegisterId = await jsonRpc("object", "execute_kw", [
        dbName, uid, dbPass, "account.payment.register", "create",
        [{
          active_model: 'account.move',
          active_ids: [invoiceId],
          journal_id: journalId,
          amount: parseFloat(Data.InvoiceValue),
          payment_date: new Date().toISOString().split("T")[0],
          communication: `MF-${Data.InvoiceId}`,
        }]
      ]);

      // Execute Payment Action
      await jsonRpc("object", "execute_kw", [
        dbName, uid, dbPass, "account.payment.register", "action_create_payments", [[paymentRegisterId]]
      ]);

      console.log(`✅ Success: Invoice MF-${Data.InvoiceId} posted and paid via account 101007`);
    } else {
      console.warn("⚠️ Warning: Invoice posted but journal for account 101007 not found. Payment not registered.");
    }

    res.status(200).json({
      success: true,
      message: "Invoice synced and paid",
      odoo_invoice_id: invoiceId,
    });

  } catch (error) {
    console.error("❌ Sync Error:", error.message);
    res.status(500).json({ error: error.message });
  }
};

module.exports = {
  myfatoorah_odoo_controller,
};
const crypto = require("crypto");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

/**
 * myFatoorah to Odoo Integration - V2 WEBHOOK VERSION
 */

const validateSignature = (body, signature, secretKey) => {
  if (!signature || !body || !body.Data) return false;

  const { Invoice, Transaction } = body.Data;

  /**
   * MyFatoorah V2 Signature Requirement:
   * Data must be joined by commas in this EXACT order:
   * Invoice.Id, Invoice.Status, Transaction.Status, Transaction.PaymentId, Invoice.ExternalIdentifier
   */
  const signString = [
    `Invoice.Id=${Invoice?.Id || ""}`,
    `Invoice.Status=${Invoice?.Status || ""}`,
    `Transaction.Status=${Transaction?.Status || ""}`,
    `Transaction.PaymentId=${Transaction?.PaymentId || ""}`,
    `Invoice.ExternalIdentifier=${Invoice?.ExternalIdentifier || ""}`
  ].join(",");

  const hash = crypto
    .createHmac("sha256", secretKey)
    .update(signString)
    .digest("base64"); // Webhook signatures are Base64 encoded

  console.log("🔎 Generated Hash:", hash);
  console.log("🔎 Received Signature:", signature);

  return hash === signature;
};

const jsonRpc = async (service, method, args, context = {}) => {
  const payload = {
    jsonrpc: "2.0",
    method: "call",
    params: { service, method, args },
    id: Math.floor(Math.random() * 1000000),
  };

  if (Object.keys(context).length > 0) {
    payload.params.context = context;
  }

  const response = await fetch(process.env.ODOO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const result = await response.json();
  if (result.error) throw new Error(`Odoo Error: ${result.error.data.message}`);
  return result.result;
};

const myfatoorah_odoo_controller = async (req, res) => {
  console.log("------------ WEBHOOK RECEIVED ------------");

  try {
    const { Data, Event } = req.body;
    const signature = req.headers["myfatoorah-signature"] || req.headers["MyFatoorah-Signature"];
    const secretKey = process.env.MYFATOORAH_SECRET_KEY;

    if (!secretKey) {
      console.error("❌ MYFATOORAH_SECRET_KEY is missing");
      return res.status(500).json({ error: "Server configuration error" });
    }

    // 1. SIGNATURE VALIDATION (V2 Logic)
    if (!validateSignature(req.body, signature, secretKey)) {
      console.error("❌ SIGNATURE MISMATCH");
      return res.status(401).json({ error: "Invalid Signature" });
    }

    // 2. STATUS CHECK (V2 Logic: Invoice PAID and Transaction SUCCESS)
    if (
      Event.Name !== "PAYMENT_STATUS_CHANGED" || 
      Data.Invoice.Status !== "PAID" || 
      Data.Transaction.Status !== "SUCCESS"
    ) {
      console.log("ℹ️ Event ignored (Payment not fully successful)");
      return res.status(200).json({ message: "Event ignored" });
    }

    console.log("✅ Valid paid webhook received");

    const db = process.env.ODOO_DB;
    const user = process.env.ODOO_USER;
    const pass = process.env.ODOO_PASS;

    const uid = await jsonRpc("common", "login", [db, user, pass]);

    const rawInvoiceId = String(Data.Invoice.Id);
    const mfRef = `MF-${rawInvoiceId}`;

    // 3. Deduplication
    const existing = await jsonRpc("object", "execute_kw", [
      db, uid, pass, "account.move", "search", [[["ref", "=", mfRef]]],
    ]);

    if (existing.length > 0) {
      console.log("⚠️ Duplicate invoice skipped");
      return res.status(200).json({ message: "Duplicate" });
    }

    // 4. Get USD Currency
    const currencies = await jsonRpc("object", "execute_kw", [
      db, uid, pass, "res.currency", "search", [[["name", "=", "USD"]]],
    ]);
    const usdId = currencies[0];

    // 5. Partner Logic
    const email = req.body.Customer?.Email || `mf-${rawInvoiceId}@example.com`;
    const partners = await jsonRpc("object", "execute_kw", [
      db, uid, pass, "res.partner", "search", [[["email", "=", email]]],
    ]);

    let partnerId = partners[0];
    if (!partnerId) {
      partnerId = await jsonRpc("object", "execute_kw", [
        db, uid, pass, "res.partner", "create",
        [{ name: req.body.Customer?.Name || "Customer", email }],
      ]);
    }

    // 6. Create Odoo Invoice
    const invId = await jsonRpc("object", "execute_kw", [
      db, uid, pass, "account.move", "create",
      [{
        move_type: "out_invoice",
        partner_id: partnerId,
        currency_id: usdId,
        ref: mfRef,
        invoice_line_ids: [[0, 0, {
          name: `MyFatoorah #${rawInvoiceId}`,
          quantity: 1,
          price_unit: parseFloat(Data.Amount.ValueInDisplayCurrency),
        }]],
      }],
    ]);

    // 7. Post Invoice
    await jsonRpc("object", "execute_kw", [
      db, uid, pass, "account.move", "action_post", [[invId]],
    ]);

    // 8. Register Payment
    const journal = await jsonRpc("object", "execute_kw", [
      db, uid, pass, "account.journal", "read", [[6], ["inbound_payment_method_line_ids"]],
    ]);

    const methodLineId = journal[0].inbound_payment_method_line_ids[0];

    const regId = await jsonRpc("object", "execute_kw", [
      db, uid, pass, "account.payment.register", "create",
      [{
        journal_id: 6,
        payment_method_line_id: methodLineId,
        amount: parseFloat(Data.Amount.ValueInDisplayCurrency),
        communication: mfRef,
      }],
      {
        active_model: "account.move",
        active_ids: [invId],
      }
    ]);

    await jsonRpc("object", "execute_kw", [
      db, uid, pass, "account.payment.register", "action_create_payments", [[regId]],
    ]);

    console.log(`✅ SUCCESS: ${mfRef} synced to Odoo`);
    return res.status(200).json({ success: true });

  } catch (err) {
    console.error("❌ ERROR:", err.message);
    return res.status(500).json({ error: err.message });
  }
};

module.exports = { myfatoorah_odoo_controller };

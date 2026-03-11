const crypto = require("crypto");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

/**
 * myFatoorah to Odoo Integration - VERCEL VERSION
 * Strictly following MyFatoorah V2 Signature & Webhook Docs
 */

const validateSignature = (body, signature, secretKey) => {
  if (!signature || !body.Data) return false;

  const data = body.Data;
  
  // 1. Sort keys alphabetically as per MyFatoorah docs
  const sortedKeys = Object.keys(data).sort();

  // 2. Construct the string: Key=Value,Key2=Value2
  // Important: Handle null values by converting them to empty strings
  const signString = sortedKeys
    .map((key) => {
      const value = data[key] === null ? "" : data[key];
      return `${key}=${value}`;
    })
    .join(",");

  // 3. HMAC-SHA256 Base64 Encoding
  const hash = crypto
    .createHmac("sha256", secretKey)
    .update(signString, "utf8")
    .digest("base64");

  return hash === signature;
};

const jsonRpc = async (service, method, args) => {
  const payload = {
    jsonrpc: "2.0",
    method: "call",
    params: { service, method, args },
    id: Math.floor(Math.random() * 1000000),
  };

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
  // LOG 1: Check if Vercel even receives the request
  console.log("--- Webhook Hit Received ---");

  try {
    const { Data, Event } = req.body;
    const signature = req.headers["myfatoorah-signature"];
    const secretKey = process.env.MYFATOORAH_SECRET_KEY;

    // LOG 2: Check headers/body in Vercel Logs
    console.log("Signature Header:", signature);
    console.log("Event Name:", Event?.Name);

    // 1. SIGNATURE VALIDATION
    if (!validateSignature(req.body, signature, secretKey)) {
      console.error("❌ SIGNATURE MISMATCH: Check MYFATOORAH_SECRET_KEY in Vercel Vars");
      return res.status(401).json({ error: "Invalid Signature" });
    }

    // 2. FILTER: Only PAID status
    if (Event.Name !== "PAYMENT_STATUS_CHANGED" || Data.Invoice.Status !== "PAID") {
      return res.status(200).json({ message: "Not a paid invoice event" });
    }

    // --- ODOO LOGIC ---
    const db = process.env.ODOO_DB;
    const user = process.env.ODOO_USER;
    const pass = process.env.ODOO_PASS;

    const uid = await jsonRpc("common", "login", [db, user, pass]);
    const rawInvoiceId = String(Data.Invoice.Id);
    const mfRef = `MF-${rawInvoiceId}`;

    // 3. DEDUPLICATION
    const existing = await jsonRpc("object", "execute_kw", [
      db, uid, pass, "account.move", "search", [[["ref", "=", mfRef]]]
    ]);
    if (existing.length > 0) return res.status(200).json({ message: "Duplicate" });

    // 4. USD CURRENCY
    const currencies = await jsonRpc("object", "execute_kw", [
      db, uid, pass, "res.currency", "search", [[["name", "=", "USD"]]]
    ]);
    const usdId = currencies[0];

    // 5. PARTNER
    const email = Data.Customer.Email || `mf-${rawInvoiceId}@example.com`;
    const partners = await jsonRpc("object", "execute_kw", [
      db, uid, pass, "res.partner", "search", [[["email", "=", email]]]
    ]);
    let partnerId = partners[0];
    if (!partnerId) {
      partnerId = await jsonRpc("object", "execute_kw", [
        db, uid, pass, "res.partner", "create",
        [{ name: Data.Customer.Name || "Customer", email }]
      ]);
    }

    // 6. CREATE & POST INVOICE
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
          price_unit: parseFloat(Data.Amount.ValueInDisplayCurrency)
        }]]
      }]
    ]);
    await jsonRpc("object", "execute_kw", [db, uid, pass, "account.move", "action_post", [[invId]]]);

    // 7. PAYMENT REGISTRATION (Journal 6, Account 170)
    const journal = await jsonRpc("object", "execute_kw", [
      db, uid, pass, "account.journal", "read", [[6], ["inbound_payment_method_line_ids"]]
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
      { context: { active_model: "account.move", active_ids: [invId], default_account_id: 170 } }
    ]);

    await jsonRpc("object", "execute_kw", [
      db, uid, pass, "account.payment.register", "action_create_payments", [[regId]]
    ]);

    console.log(`✅ SUCCESS: MF-${rawInvoiceId} registered in Odoo.`);
    return res.status(200).json({ success: true });

  } catch (err) {
    console.error("❌ ERROR:", err.message);
    return res.status(500).json({ error: err.message });
  }
};

module.exports = { myfatoorah_odoo_controller };
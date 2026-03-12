const crypto = require("crypto");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

/**
 * myFatoorah to Odoo Integration - VERCEL VERSION
 */

const validateSignature = (body, signature, secretKey) => {
  if (!signature || !body || !body.Data) {
    console.log("❌ Missing signature or body data");
    return false;
  }

  const data = body.Data;

  // Sort keys alphabetically
  const sortedKeys = Object.keys(data).sort();

  const signString = sortedKeys
    .map((key) => {
      const value = data[key] === null ? "" : data[key];
      return `${key}=${value}`;
    })
    .join(",");

  console.log("🔎 Sign String:", signString);

  const hash = crypto
    .createHmac("sha256", secretKey)
    .update(signString, "utf8")
    .digest("base64");

  console.log("🔎 Generated Hash:", hash);
  console.log("🔎 Received Signature:", signature);

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

  if (result.error)
    throw new Error(`Odoo Error: ${result.error.data.message}`);

  return result.result;
};

const myfatoorah_odoo_controller = async (req, res) => {

  console.log("------------ WEBHOOK RECEIVED ------------");

  try {

    console.log("Headers:", req.headers);
    console.log("Body:", JSON.stringify(req.body, null, 2));

    const { Data, Event } = req.body;

    const signature =
      req.headers["myfatoorah-signature"] ||
      req.headers["MyFatoorah-Signature"];

    console.log("Signature Header:", signature);

    const secretKey = process.env.MYFATOORAH_SECRET_KEY;

    console.log("Secret Key Loaded:", !!secretKey);

    if (!secretKey) {
      console.error("❌ MYFATOORAH_SECRET_KEY is missing from Vercel env");
      return res.status(500).json({ error: "Server configuration error" });
    }

    console.log("Event Name:", Event?.Name);

    // SIGNATURE VALIDATION
    if (!validateSignature(req.body, signature, secretKey)) {
      console.error("❌ SIGNATURE MISMATCH");
      return res.status(401).json({ error: "Invalid Signature" });
    }

    // Only continue if payment became PAID
    if (
      Event.Name !== "PAYMENT_STATUS_CHANGED" ||
      Data.Invoice.Status !== "PAID"
    ) {
      console.log("ℹ️ Event ignored (not paid)");
      return res.status(200).json({ message: "Not a paid invoice event" });
    }

    console.log("✅ Valid paid webhook received");

    const db = process.env.ODOO_DB;
    const user = process.env.ODOO_USER;
    const pass = process.env.ODOO_PASS;

    const uid = await jsonRpc("common", "login", [db, user, pass]);

    const rawInvoiceId = String(Data.Invoice.Id);
    const mfRef = `MF-${rawInvoiceId}`;

    // Deduplication
    const existing = await jsonRpc("object", "execute_kw", [
      db,
      uid,
      pass,
      "account.move",
      "search",
      [[["ref", "=", mfRef]]],
    ]);

    if (existing.length > 0) {
      console.log("⚠️ Duplicate invoice skipped");
      return res.status(200).json({ message: "Duplicate" });
    }

    // Currency USD
    const currencies = await jsonRpc("object", "execute_kw", [
      db,
      uid,
      pass,
      "res.currency",
      "search",
      [[["name", "=", "USD"]]],
    ]);

    const usdId = currencies[0];

    // Partner
    const email =
      Data.Customer.Email || `mf-${rawInvoiceId}@example.com`;

    const partners = await jsonRpc("object", "execute_kw", [
      db,
      uid,
      pass,
      "res.partner",
      "search",
      [[["email", "=", email]]],
    ]);

    let partnerId = partners[0];

    if (!partnerId) {
      partnerId = await jsonRpc("object", "execute_kw", [
        db,
        uid,
        pass,
        "res.partner",
        "create",
        [
          {
            name: Data.Customer.Name || "Customer",
            email,
          },
        ],
      ]);
    }

    // Create Invoice
    const invId = await jsonRpc("object", "execute_kw", [
      db,
      uid,
      pass,
      "account.move",
      "create",
      [
        {
          move_type: "out_invoice",
          partner_id: partnerId,
          currency_id: usdId,
          ref: mfRef,
          invoice_line_ids: [
            [
              0,
              0,
              {
                name: `MyFatoorah #${rawInvoiceId}`,
                quantity: 1,
                price_unit: parseFloat(
                  Data.Amount.ValueInDisplayCurrency
                ),
              },
            ],
          ],
        },
      ],
    ]);

    await jsonRpc("object", "execute_kw", [
      db,
      uid,
      pass,
      "account.move",
      "action_post",
      [[invId]],
    ]);

    // Payment Registration
    const journal = await jsonRpc("object", "execute_kw", [
      db,
      uid,
      pass,
      "account.journal",
      "read",
      [[6], ["inbound_payment_method_line_ids"]],
    ]);

    const methodLineId =
      journal[0].inbound_payment_method_line_ids[0];

    const regId = await jsonRpc("object", "execute_kw", [
      db,
      uid,
      pass,
      "account.payment.register",
      "create",
      [
        {
          journal_id: 6,
          payment_method_line_id: methodLineId,
          amount: parseFloat(
            Data.Amount.ValueInDisplayCurrency
          ),
          communication: mfRef,
        },
      ],
      {
        context: {
          active_model: "account.move",
          active_ids: [invId],
          default_account_id: 170,
        },
      },
    ]);

    await jsonRpc("object", "execute_kw", [
      db,
      uid,
      pass,
      "account.payment.register",
      "action_create_payments",
      [[regId]],
    ]);

    console.log(`✅ SUCCESS: MF-${rawInvoiceId} created in Odoo`);

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error("❌ ERROR:", err.message);
    return res.status(500).json({ error: err.message });
  }
};

module.exports = { myfatoorah_odoo_controller };
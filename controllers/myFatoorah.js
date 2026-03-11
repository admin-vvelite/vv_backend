const crypto = require("crypto");

// dynamic import for node-fetch
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

/**
 * MyFatoorah → Odoo Controller
 * Webhook V2 Compatible
 */

const jsonRpc = async (service, method, args, kwargs = {}) => {
  const ODOO_CONFIG = {
    url: process.env.ODOO_URL,
    db: process.env.ODOO_DB,
    username: process.env.ODOO_USER,
    password: process.env.ODOO_PASS,
  };

  const payload = {
    jsonrpc: "2.0",
    method: "call",
    params: { service, method, args, kwargs },
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

    console.log("Webhook received:", JSON.stringify(req.body, null, 2));

    const { Event, Data } = req.body;

    // 1️⃣ Validate event name (Webhook V2 structure)
    if (!Event || Event.Name !== "PAYMENT_STATUS_CHANGED") {
      return res.status(200).json({ message: "Event ignored" });
    }

    // 2️⃣ Validate payment success
    if (
      Data?.Invoice?.Status !== "PAID" ||
      Data?.Transaction?.Status !== "SUCCESS"
    ) {
      return res.status(200).json({ message: "Payment not successful yet" });
    }

    const invoiceIdMF = Data.Invoice.Id;

    const dbName = process.env.ODOO_DB;
    const dbUser = process.env.ODOO_USER;
    const dbPass = process.env.ODOO_PASS;

    // 3️⃣ Odoo Authentication
    const uid = await jsonRpc("common", "login", [dbName, dbUser, dbPass]);
    if (!uid) throw new Error("Odoo Authentication Failed");


    // 4️⃣ Prevent duplicate invoices
    const existingInvoice = await jsonRpc("object", "execute_kw", [
      dbName,
      uid,
      dbPass,
      "account.move",
      "search",
      [[["ref", "=", `MF-${invoiceIdMF}`]]],
    ]);

    if (existingInvoice.length > 0) {
      console.log(`Duplicate detected: MF-${invoiceIdMF}`);
      return res.status(200).json({ message: "Duplicate skipped" });
    }


    // 5️⃣ Get USD currency
    const currencyIds = await jsonRpc("object", "execute_kw", [
      dbName,
      uid,
      dbPass,
      "res.currency",
      "search",
      [[["name", "=", "USD"]]],
    ]);

    const usdId = currencyIds.length ? currencyIds[0] : false;


    // 6️⃣ Customer data (Webhook V2 location)
    const email = Data.Customer?.Email || "unknown@email.com";
    const name = Data.Customer?.Name || "MyFatoorah Customer";
    const phone = Data.Customer?.Mobile || "";

    let partnerId;

    const searchPartner = await jsonRpc("object", "execute_kw", [
      dbName,
      uid,
      dbPass,
      "res.partner",
      "search",
      [[["email", "=", email]]],
    ]);

    if (searchPartner.length > 0) {
      partnerId = searchPartner[0];
    } else {
      partnerId = await jsonRpc("object", "execute_kw", [
        dbName,
        uid,
        dbPass,
        "res.partner",
        "create",
        [
          {
            name: name,
            email: email,
            phone: phone,
          },
        ],
      ]);
    }


    // 7️⃣ Invoice lines
    const amount = parseFloat(Data.Amount.ValueInDisplayCurrency);

    const invoiceLines = [
      [
        0,
        0,
        {
          name: "Payment via MyFatoorah",
          quantity: 1,
          price_unit: amount,
          tax_ids: [[6, 0, []]],
        },
      ],
    ];


    // 8️⃣ Create invoice
    const invoiceId = await jsonRpc("object", "execute_kw", [
      dbName,
      uid,
      dbPass,
      "account.move",
      "create",
      [
        {
          move_type: "out_invoice",
          partner_id: partnerId,
          currency_id: usdId,
          invoice_date: new Date().toISOString().split("T")[0],
          ref: `MF-${invoiceIdMF}`,
          invoice_line_ids: invoiceLines,
        },
      ],
    ]);


    // 9️⃣ Post invoice
    await jsonRpc("object", "execute_kw", [
      dbName,
      uid,
      dbPass,
      "account.move",
      "action_post",
      [[invoiceId]],
    ]);


    // 🔟 Find cash journal
    const cashJournalSearch = await jsonRpc("object", "execute_kw", [
      dbName,
      uid,
      dbPass,
      "account.journal",
      "search",
      [[["code", "=", "CSH1"]]],
    ]);

    if (cashJournalSearch.length === 0) {
      throw new Error("Cash Journal CSH1 not found.");
    }

    const journalId = cashJournalSearch[0];


    // 11️⃣ Register payment
    const paymentRegisterId = await jsonRpc(
      "object",
      "execute_kw",
      [
        dbName,
        uid,
        dbPass,
        "account.payment.register",
        "create",
        [
          {
            journal_id: journalId,
            amount: amount,
            payment_date: new Date().toISOString().split("T")[0],
            communication: `MF-${invoiceIdMF}`,
          },
        ],
      ],
      {
        context: {
          active_model: "account.move",
          active_ids: [invoiceId],
        },
      }
    );


    // 12️⃣ Execute payment
    await jsonRpc("object", "execute_kw", [
      dbName,
      uid,
      dbPass,
      "account.payment.register",
      "action_create_payments",
      [[paymentRegisterId]],
    ]);


    console.log(`Success: MF-${invoiceIdMF} synced to Odoo`);

    res.status(200).json({
      success: true,
      message: "Invoice synced and paid",
      odoo_invoice_id: invoiceId,
    });

  } catch (error) {
    console.error("Sync Error:", error.message);
    res.status(500).json({ error: error.message });
  }
};


module.exports = {
  myfatoorah_odoo_controller,
};
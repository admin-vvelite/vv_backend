// If you are on Node.js < 18, uncomment the line below:
// const fetch = require("node-fetch");

// --- HELPER: GENERIC JSON-RPC ---
const jsonRpc = async (service, method, args) => {
  // CONFIG MOVED INSIDE: Prevents 'undefined' error if dotenv loads late
  const ODOO_CONFIG = {
    url: process.env.ODOO_URL || "https://vvelite2.odoo.com/jsonrpc",
    db: process.env.ODOO_DB || "vvelite2",
    username: process.env.ODOO_USER || "admin@vvelite.com",
    password: process.env.ODOO_PASS // API Key from .env
  };

  if (!ODOO_CONFIG.password) {
      throw new Error("Missing Odoo API Key. Check your .env file.");
  }

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
    throw new Error(
      `Odoo Error (${result.error.data.message}): ${result.error.data.debug}`
    );
  }
  return result.result;
};

// --- MAIN CONTROLLER ---
const invoices_controller = async (req, res) => {
  const order = req.body;

  // 1. Basic Validation
  if (!order.id || !order.line_items) {
    return res.status(400).json({ error: "Invalid Shopify Payload" });
  }

  try {
    console.log(`Processing Order: ${order.name}`);
    
    // We need config vars for the login call too
    const dbName = process.env.ODOO_DB || "vvelite2";
    const dbUser = process.env.ODOO_USER || "admin@vvelite.com";
    const dbPass = process.env.ODOO_PASS;

    // 2. Authenticate & Get UID
    const uid = await jsonRpc("common", "login", [
      dbName,
      dbUser,
      dbPass,
    ]);

    if (!uid) throw new Error("Odoo Authentication Failed");

    // --- STEP 1: CUSTOMER (CHECK OR CREATE) ---
    const email = order.email || order.customer.email;
    let partnerId;

    // Search by email
    const searchPartner = await jsonRpc("object", "execute_kw", [
      dbName, uid, dbPass,
      "res.partner", "search",
      [[["email", "=", email]]],
    ]);

    if (searchPartner.length > 0) {
      partnerId = searchPartner[0];
    } else {
      // Create new
      partnerId = await jsonRpc("object", "execute_kw", [
        dbName, uid, dbPass,
        "res.partner", "create",
        [{
            name: `${order.customer.first_name} ${order.customer.last_name}`,
            email: email,
            phone: order.customer.phone || "",
            street: order.shipping_address?.address1,
            city: order.shipping_address?.city,
            zip: order.shipping_address?.zip,
            country_code: order.shipping_address?.country_code,
        }],
      ]);
    }

    // --- STEP 2: PREPARE INVOICE LINES (NET PRICE LOGIC) ---
    const invoiceLines = [];

    for (const item of order.line_items) {
      // A. Find Product ID in Odoo using SKU
      let productId = false;
      if (item.sku) {
        const productSearch = await jsonRpc("object", "execute_kw", [
          dbName, uid, dbPass,
          "product.product", "search",
          [[["default_code", "=", item.sku]]],
        ]);
        if (productSearch.length > 0) productId = productSearch[0];
      }

      // B. Calculate Net Price
      const rawPrice = parseFloat(item.price);
      const totalLineDiscount = parseFloat(item.total_discount || 0);
      const netUnitTest = (rawPrice * item.quantity - totalLineDiscount) / item.quantity;

      invoiceLines.push([
        0, 0,
        {
          product_id: productId || undefined,
          name: item.name,
          quantity: item.quantity,
          price_unit: netUnitTest,
          discount: 0,
          tax_ids: [[6, 0, []]], 
        },
      ]);
    }

    // --- STEP 3: CREATE INVOICE ---
    const invoiceId = await jsonRpc("object", "execute_kw", [
      dbName, uid, dbPass,
      "account.move", "create",
      [{
          move_type: "out_invoice",
          partner_id: partnerId,
          invoice_date: order.created_at.split("T")[0],
          
          // FIX 1: 'ref' is correct for account.move (Invoice)
          ref: order.name, 
          
          payment_reference: order.id.toString(),
          invoice_line_ids: invoiceLines,
      }],
    ]);

    // --- STEP 4: POST INVOICE ---
    await jsonRpc("object", "execute_kw", [
      dbName, uid, dbPass,
      "account.move", "action_post",
      [[invoiceId]],
    ]);

    // --- STEP 5: REGISTER PAYMENT (If Paid) ---
    if (order.financial_status === "paid" || order.financial_status === "partially_paid") {

      const journalSearch = await jsonRpc("object", "execute_kw", [
        dbName, uid, dbPass,
        "account.journal", "search",
        [[["type", "=", "bank"]]],
      ]);

      const journalId = journalSearch.length > 0 ? journalSearch[0] : false;

      if (journalId) {
        const paymentId = await jsonRpc("object", "execute_kw", [
          dbName, uid, dbPass,
          "account.payment", "create",
          [{
              partner_id: partnerId,
              amount: parseFloat(order.total_price),
              date: order.created_at.split("T")[0],
              journal_id: journalId,
              payment_type: "inbound",
              partner_type: "customer",
              
              // FIX 2: 'memo' is correct for account.payment (Payment)
              memo: `Shopify Order ${order.name}`, 
          }],
        ]);

        await jsonRpc("object", "execute_kw", [
          dbName, uid, dbPass,
          "account.payment", "action_post",
          [[paymentId]],
        ]);
      }
    }

    res.status(200).json({
      success: true,
      message: "Synced to Odoo",
      odoo_invoice_id: invoiceId,
    });

  } catch (error) {
    console.error("Sync Error:", error);
    res.status(500).json({ error: error.message });
  }
};

module.exports = { invoices_controller };
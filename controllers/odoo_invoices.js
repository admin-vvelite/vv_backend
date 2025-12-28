const GATEWAY_TO_ACCOUNT_CODE = {
  tap: "101008", // Tap pay Treasury
  stc_pay: "101009", // Stc pay Treasury
  tamara: "101010", // Tamara Treasury
  paypal: "101011", // Pay pal Treasury
  moyassar: "101012", // Moyassar Treasury
  alrajhi: "101020", // Alrajhi Bank (SAR)
};

const DEFAULT_ACCOUNT_CODE = "101020";

const jsonRpc = async (service, method, args) => {
  const ODOO_CONFIG = {
    url: process.env.ODOO_URL,
    db: process.env.ODOO_DB || "vvelite2",
    username: process.env.ODOO_USER || "admin@vvelite.com",
    password: process.env.ODOO_PASS, // API Key
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

  if (!order.id || !order.line_items) {
    return res.status(400).json({ error: "Invalid Shopify Payload" });
  }

  try {
    console.log(`Processing Order: ${order.name}`);

    const dbName = process.env.ODOO_DB;
    const dbUser = process.env.ODOO_USER;
    const dbPass = process.env.ODOO_PASS;

    const uid = await jsonRpc("common", "login", [dbName, dbUser, dbPass]);
    if (!uid) throw new Error("Odoo Authentication Failed");

    const email = order.email || order.customer.email;
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
            name: `${order.customer.first_name} ${order.customer.last_name}`,
            email: email,
            phone: order.customer.phone || "",
            street: order.shipping_address?.address1,
            city: order.shipping_address?.city,
            zip: order.shipping_address?.zip,
            country_code: order.shipping_address?.country_code,
          },
        ],
      ]);
    }

    const invoiceLines = [];

    for (const item of order.line_items) {
      let productId = false;
      if (item.sku) {
        const productSearch = await jsonRpc("object", "execute_kw", [
          dbName,
          uid,
          dbPass,
          "product.product",
          "search",
          [[["default_code", "=", item.sku]]],
        ]);
        if (productSearch.length > 0) productId = productSearch[0];
      }

      const rawPrice = parseFloat(item.price);
      const totalLineDiscount = parseFloat(item.total_discount || 0);

      const netUnitTest =
        (rawPrice * item.quantity - totalLineDiscount) / item.quantity;

      invoiceLines.push([
        0,
        0,
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
          invoice_date: order.created_at.split("T")[0],
          ref: order.name,
          payment_reference: order.id.toString(),
          invoice_line_ids: invoiceLines,
        },
      ],
    ]);

    await jsonRpc("object", "execute_kw", [
      dbName,
      uid,
      dbPass,
      "account.move",
      "action_post",
      [[invoiceId]],
    ]);

    if (
      order.financial_status === "paid" ||
      order.financial_status === "partially_paid"
    ) {
      const shopifyGateway = (
        order.gateway ||
        (order.payment_gateway_names && order.payment_gateway_names[0]) ||
        ""
      ).toLowerCase();

      // B Get Target Account Code from Map
      const targetAccountCode =
        GATEWAY_TO_ACCOUNT_CODE[shopifyGateway] || DEFAULT_ACCOUNT_CODE;

      console.log(
        `Payment Gateway: ${shopifyGateway} -> Target Account: ${targetAccountCode}`
      );

      // 1 Find Account ID first
      const accountSearch = await jsonRpc("object", "execute_kw", [
        dbName,
        uid,
        dbPass,
        "account.account",
        "search",
        [[["code", "=", targetAccountCode]]],
      ]);

      if (accountSearch.length > 0) {
        const accountId = accountSearch[0];

        // 2 Find Journal using this Account
        const journalSearch = await jsonRpc("object", "execute_kw", [
          dbName,
          uid,
          dbPass,
          "account.journal",
          "search",
          [[["default_account_id", "=", accountId]]],
        ]);

        if (journalSearch.length > 0) {
          const journalId = journalSearch[0];

          // D Create Payment
          const paymentId = await jsonRpc("object", "execute_kw", [
            dbName,
            uid,
            dbPass,
            "account.payment",
            "create",
            [
              {
                partner_id: partnerId,
                amount: parseFloat(order.total_price),
                date: order.created_at.split("T")[0],
                journal_id: journalId, // The Specific Treasury Journal
                payment_type: "inbound",
                partner_type: "customer",
                memo: `Shopify Order ${order.name}`, // Use 'memo' for Payments
              },
            ],
          ]);

          // E Post Payment
          await jsonRpc("object", "execute_kw", [
            dbName,
            uid,
            dbPass,
            "account.payment",
            "action_post",
            [[paymentId]],
          ]);

          console.log(`Payment Registered on Journal ID: ${journalId}`);
        } else {
          console.warn(
            `No Journal found for Account Code ${targetAccountCode}`
          );
        }
      } else {
        console.warn(`Account Code ${targetAccountCode} not found in Odoo`);
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

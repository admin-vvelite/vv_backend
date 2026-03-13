const BANK_JOURNAL_ID = 6;
const CURRENCY = "USD";

const jsonRpc = async (service, method, args) => {
  const ODOO_CONFIG = {
    url: process.env.ODOO_URL,
    db: process.env.ODOO_DB || "vvelite2",
    username: process.env.ODOO_USER || "admin@vvelite.com",
    password: process.env.ODOO_PASS,
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

// MAIN CONTROLLER
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

    const email = order.email || order.customer?.email;

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
            name: `${order.customer?.first_name || ""} ${
              order.customer?.last_name || ""
            }`,
            email: email,
            phone: order.customer?.phone || "",
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

      const netUnitPrice =
        (rawPrice * item.quantity - totalLineDiscount) / item.quantity;

      invoiceLines.push([
        0,
        0,
        {
          product_id: productId || undefined,
          name: item.name,
          quantity: item.quantity,
          price_unit: netUnitPrice,
          discount: 0,
          tax_ids: [[6, 0, []]],
        },
      ]);
    }

    // GET USD CURRENCY ID
    const currencySearch = await jsonRpc("object", "execute_kw", [
      dbName,
      uid,
      dbPass,
      "res.currency",
      "search",
      [[["name", "=", CURRENCY]]],
    ]);

    const currencyId = currencySearch[0];

    // CREATE INVOICE
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
          currency_id: currencyId,
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

    // REGISTER PAYMENT
    if (
      order.financial_status === "paid" ||
      order.financial_status === "partially_paid"
    ) {
      console.log(`Registering payment in Bank Journal 6`);

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
            currency_id: currencyId,
            date: order.created_at.split("T")[0],
            journal_id: BANK_JOURNAL_ID,
            payment_type: "inbound",
            partner_type: "customer",
            memo: `Shopify Order ${order.name}`,
          },
        ],
      ]);

      await jsonRpc("object", "execute_kw", [
        dbName,
        uid,
        dbPass,
        "account.payment",
        "action_post",
        [[paymentId]],
      ]);

      console.log(`Payment Registered in Bank Journal`);
    }

    res.status(200).json({
      success: true,
      message: "Synced to Odoo",
      odoo_invoice_id: invoiceId,
    });
  } catch (error) {
    console.error("Sync Error:", error);

    res.status(500).json({
      error: error.message,
    });
  }
};

module.exports = { invoices_controller };

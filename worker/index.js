// =====================================================================
// FORN EL BATATA: SERVER CODE (runs on Cloudflare, next to the website)
//
// Handles online card payments with Paymob:
//   POST /api/create-payment  → website asks for a Paymob payment page for an order
//   POST /api/paymob-webhook  → Paymob tells us (securely) if a payment succeeded
//   GET  /api/paymob-return   → Paymob sends the customer back here after paying
//
// Secret keys are NOT in this file. They are stored in Cloudflare
// (Worker → Settings → Variables and Secrets):
//   PAYMOB_SECRET_KEY, PAYMOB_PUBLIC_KEY, PAYMOB_HMAC_SECRET,
//   PAYMOB_INTEGRATION_IDS, SUPABASE_SECRET_KEY
// =====================================================================

const PAYMOB = "https://accept.paymob.com";
const CODE_RE = /^[A-F0-9]{6}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        if (!paymentsConfigured(env)) return json({ error: "Card payments are not set up yet." }, 503);
        if (url.pathname === "/api/create-payment" && request.method === "POST") return await createPayment(request, env, url);
        if (url.pathname === "/api/paymob-webhook" && request.method === "POST") return await webhook(request, env, url);
        if (url.pathname === "/api/paymob-return" && request.method === "GET") return await paymentReturn(env, url);
        return json({ error: "Not found" }, 404);
      } catch (err) {
        console.error("API error", err);
        return json({ error: "Something went wrong. Please try again." }, 500);
      }
    }
    return env.ASSETS.fetch(request); // everything else: the website files
  },
};

function paymentsConfigured(env) {
  return ["PAYMOB_SECRET_KEY", "PAYMOB_PUBLIC_KEY", "PAYMOB_HMAC_SECRET", "PAYMOB_INTEGRATION_IDS", "SUPABASE_SECRET_KEY", "SUPABASE_URL"]
    .every((k) => env[k]);
}

// ---------- 1. Create a Paymob payment page for an order ----------
async function createPayment(request, env, url) {
  const { code } = await request.json().catch(() => ({}));
  if (!CODE_RE.test(code || "")) return json({ error: "Invalid order." }, 400);

  const [order] = await db(env, `orders?code=eq.${code}&select=*,order_items(*)`);
  if (!order) return json({ error: "Order not found." }, 404);
  if (order.payment_method !== "card" || order.payment_status === "paid" || order.status === "cancelled") {
    return json({ error: "This order can't be paid online." }, 409);
  }
  if (Date.now() - new Date(order.created_at).getTime() > 60 * 60 * 1000) {
    return json({ error: "This order is too old to pay for. Please place a new order." }, 409);
  }

  // Prices come from OUR database, never from the customer's browser.
  const items = order.order_items.map((i) => ({ name: i.name.slice(0, 50), amount: i.unit_price * 100, quantity: i.quantity }));
  if (order.delivery_fee > 0) items.push({ name: `Delivery (${order.area})`.slice(0, 50), amount: order.delivery_fee * 100, quantity: 1 });

  const [first, ...rest] = order.customer_name.trim().split(/\s+/);
  const body = {
    amount: order.total * 100,                 // Paymob counts in piasters (1 EGP = 100)
    currency: "EGP",
    payment_methods: env.PAYMOB_INTEGRATION_IDS.split(",").map((s) => Number(s.trim())).filter(Boolean),
    items,
    billing_data: {
      first_name: first || "Customer",
      last_name: rest.join(" ") || "NA",
      phone_number: order.phone,
      email: "customer@example.com",          // we don't collect emails; Paymob requires one
      street: order.address.slice(0, 100),
      building: "NA", floor: "NA", apartment: "NA",
      city: "Cairo", state: order.area, country: "EG",
    },
    special_reference: `${order.code}-${Date.now()}`, // unique per attempt; the order code comes first
    notification_url: `${url.origin}/api/paymob-webhook`,
    redirection_url: `${url.origin}/api/paymob-return`,
  };

  const res = await fetch(`${PAYMOB}/v1/intention/`, {
    method: "POST",
    headers: { Authorization: `Token ${env.PAYMOB_SECRET_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.client_secret) {
    console.error("Paymob intention failed", res.status, JSON.stringify(data));
    return json({ error: "The payment provider didn't respond. Please try again or choose cash." }, 502);
  }
  const checkout = `${PAYMOB}/unifiedcheckout/?publicKey=${encodeURIComponent(env.PAYMOB_PUBLIC_KEY)}&clientSecret=${encodeURIComponent(data.client_secret)}`;
  return json({ url: checkout });
}

// ---------- 2. Paymob tells us the result (server to server) ----------
async function webhook(request, env, url) {
  const payload = await request.json().catch(() => null);
  const t = payload?.obj;
  if (!payload || payload.type !== "TRANSACTION" || !t) return json({ ok: true }); // other event types: ignore

  const expected = await hmacHex(env.PAYMOB_HMAC_SECRET, HMAC_FIELDS.map((f) => str(get(t, f))).join(""));
  if (!safeEqual(expected, (url.searchParams.get("hmac") || "").toLowerCase())) {
    console.warn("Webhook with bad signature rejected");
    return json({ error: "Bad signature" }, 401);
  }
  await recordResult(env, {
    ref: t.order?.merchant_order_id,
    success: t.success === true && t.pending !== true,
    txnId: t.id,
    amountCents: t.amount_cents,
  });
  return json({ ok: true });
}

// ---------- 3. Customer comes back from the payment page ----------
async function paymentReturn(env, url) {
  const p = url.searchParams;
  const expected = await hmacHex(env.PAYMOB_HMAC_SECRET, HMAC_FIELDS.map((f) => p.get(f === "order.id" ? "order" : f) ?? "").join(""));
  if (!safeEqual(expected, (p.get("hmac") || "").toLowerCase())) return redirect(`${url.origin}/?failed=1`);

  const r = await recordResult(env, {
    ref: p.get("merchant_order_id"),
    success: p.get("success") === "true" && p.get("pending") !== "true",
    txnId: p.get("id"),
    amountCents: p.get("amount_cents"),
  });
  return redirect(`${url.origin}/?${r?.ok ? "paid" : "failed"}=${encodeURIComponent(r?.code || "1")}`);
}

// Save the payment result on the order (safe to call twice).
async function recordResult(env, { ref, success, txnId, amountCents }) {
  const code = String(ref || "").split("-")[0];
  if (!CODE_RE.test(code)) return null;
  const [order] = await db(env, `orders?code=eq.${code}&select=id,total,status,payment_status`);
  if (!order) return null;
  if (order.payment_status === "paid") return { code, ok: true };

  if (success) {
    if (Number(amountCents) !== order.total * 100) {
      console.error(`Amount mismatch on ${code}: paid ${amountCents}, expected ${order.total * 100}`);
      return { code, ok: false };
    }
    await db(env, `orders?id=eq.${order.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        payment_status: "paid", payment_ref: str(txnId), paid_at: new Date().toISOString(),
        ...(order.status === "cancelled" ? { status: "new" } : {}),
      }),
    });
    return { code, ok: true };
  }
  await db(env, `orders?id=eq.${order.id}`, {
    method: "PATCH",
    body: JSON.stringify({ payment_status: "failed", payment_ref: str(txnId), status: "cancelled" }),
  });
  return { code, ok: false };
}

// ---------- helpers ----------
// Paymob signs these fields, in exactly this order (see Paymob "HMAC calculation" docs).
const HMAC_FIELDS = [
  "amount_cents", "created_at", "currency", "error_occured", "has_parent_transaction", "id",
  "integration_id", "is_3d_secure", "is_auth", "is_capture", "is_refunded", "is_standalone_payment",
  "is_voided", "order.id", "owner", "pending", "source_data.pan", "source_data.sub_type",
  "source_data.type", "success",
];

async function db(env, path, init = {}) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: env.SUPABASE_SECRET_KEY, "Content-Type": "application/json", Prefer: "return=representation" },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  return res.json();
}

async function hmacHex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const get = (obj, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
const str = (v) => (v === undefined || v === null ? "" : String(v));
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const redirect = (to) => new Response(null, { status: 302, headers: { Location: to, "Cache-Control": "no-store" } });

// exported for tests
export const _test = { hmacHex, HMAC_FIELDS };

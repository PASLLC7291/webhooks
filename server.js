const express = require("express");
const { createClient } = require("redis");

const app = express();

// BASTA sends webhooks with NO Content-Type header.
// express.json() and express.text() both skip bodies with no content-type.
// This custom middleware reads the raw body and tries to JSON.parse it.
app.use((req, res, next) => {
  if (req.method !== "POST") return next();
  let body = "";
  req.on("data", (chunk) => { body += chunk.toString(); });
  req.on("end", () => {
    try {
      req.body = body ? JSON.parse(body) : {};
    } catch (e) {
      req.body = { _raw: body };
    }
    next();
  });
});

const PORT = process.env.PORT || 3001;
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const SALE_ID = process.env.SALE_ID || "test";

let redis;

// --- Templates: BASTA actionType → agent event ---
// BASTA uses actionType field with PascalCase names like BidOnItemV2, SaleUpdated, etc.
const templates = {
  BidOnItemV2: (d) => ({
    type: "BID_RECEIVED",
    data: {
      type: "BID_RECEIVED",
      userName: d.bidderName || "someone",
      amount: d.amount || 0,
      bidCount: d.bidSequenceNumber || 1,
      bidVelocity: 0,
      previousLeaderName: d.previousBidderName || null,
      itemId: d.itemId,
    },
  }),
  ItemStatusChangedV2: (d) => {
    const status = d.newStatus || d.status;
    if (status === "ITEM_OPEN") {
      return {
        type: "ITEM_START",
        data: { type: "ITEM_START", itemId: d.itemId, title: d.title || d.content?.title || "" },
      };
    }
    if (status === "ITEM_CLOSING") {
      return {
        type: "GOING_ONCE",
        data: {
          type: "GOING_ONCE",
          currentBid: d.currentBid || 0,
          leaderName: d.leadingBidderName || "the leader",
        },
      };
    }
    if (status === "ITEM_CLOSED") {
      if (d.closedWithBids) {
        return {
          type: "ITEM_CLOSED_SOLD",
          data: {
            type: "ITEM_CLOSED_SOLD",
            winnerName: d.winnerName || "the winner",
            finalPrice: d.finalPrice || 0,
            totalBids: d.totalBids || 0,
            title: d.title || d.content?.title || "",
          },
        };
      }
      return {
        type: "ITEM_CLOSED_PASSED",
        data: {
          type: "ITEM_CLOSED_PASSED",
          title: d.title || d.content?.title || "",
          reason: "No bids received",
        },
      };
    }
    return null;
  },
  SaleStatusChangedV2: (d) => {
    const status = d.newStatus || d.status;
    if (status === "OPENED") {
      return {
        type: "AUCTION_START",
        data: {
          type: "AUCTION_START",
          auctionTitle: d.title || d.content?.title || "the auction",
          totalItems: d.totalItems || 0,
        },
      };
    }
    if (status === "CLOSED") {
      return { type: "AUCTION_END", data: { type: "AUCTION_END" } };
    }
    return null;
  },
  SaleUpdated: (d) => ({
    type: "SALE_UPDATED",
    data: {
      type: "SALE_UPDATED",
      saleId: d.saleId,
      title: d.content?.title || "",
      saleType: d.saleType || "",
    },
  }),
  ItemUpdated: (d) => ({
    type: "ITEM_UPDATED",
    data: {
      type: "ITEM_UPDATED",
      itemId: d.itemId,
      title: d.content?.title || d.title || "",
    },
  }),
};

// --- Webhook endpoint ---
app.post("/webhook", async (req, res) => {
  const payload = req.body;

  // Log raw payload so we can see exactly what BASTA sends
  console.log(`[WEBHOOK RAW] ${JSON.stringify(payload)}`);

  // BASTA uses "actionType" field. Also check "type" for manual curl tests.
  const eventType = payload.actionType || payload.type;
  const data = payload.data || payload;

  console.log(`[WEBHOOK] ${eventType}`);

  const mapper = templates[eventType];
  if (!mapper) {
    console.log(`  Unhandled event type: ${eventType} (templateKey: ${templateKey})`);
    return res.status(200).json({ ok: true, handled: false });
  }

  const event = mapper(data);
  if (!event) {
    console.log(`  Mapped to null (skipped)`);
    return res.status(200).json({ ok: true, handled: false });
  }

  // Publish to Redis
  const channel = `agent:events:${SALE_ID}`;
  try {
    await redis.publish(channel, JSON.stringify(event));
    console.log(`  Published ${event.type} to ${channel}`);
  } catch (err) {
    console.error(`  Redis publish failed: ${err.message}`);
  }

  res.status(200).json({ ok: true, handled: true, type: event.type });
});

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", redis: redis?.isReady ? "connected" : "disconnected" });
});

// Start
async function start() {
  redis = createClient({ url: REDIS_URL });
  redis.on("error", (err) => console.error("Redis error:", err));
  await redis.connect();
  console.log(`Redis connected: ${REDIS_URL}`);

  app.listen(PORT, () => {
    console.log(`Webhook server listening on port ${PORT}`);
    console.log(`  POST /webhook  — receives BASTA events`);
    console.log(`  GET  /health   — health check`);
    console.log(`  Publishing to: agent:events:${SALE_ID}`);
  });
}

start().catch(console.error);

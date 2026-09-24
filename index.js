require("dotenv").config();
const fastify = require("fastify")({ logger: false });
const path = require("path");
const { Pool } = require("@neondatabase/serverless"); 

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://neondb_owner:npg_XHzkG8nMJx2B@ep-plain-night-azr7vi9q-pooler.c-3.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
  ssl: { require: true }
});

fastify.register(require("@fastify/static"), {
  root: path.join(__dirname, "public"),
  prefix: "/",
});

fastify.get("/api/stock", async (request, reply) => {
  try {
    const query = `
      SELECT 
        p.part_number, p.model, p.description, p.base_seed_qty as current_seed_qty,
        (SELECT COUNT(*) FROM shipment_items s WHERE s.part_number = p.part_number AND s.status = 'RECEIVED' AND (s.classification IS NULL OR s.classification::text NOT IN ('LEGACY_SEED', 'FOC'))) as total_refilled_received,
        (SELECT COUNT(*) FROM usage_logs u WHERE u.part_number = p.part_number) as total_used,
        (SELECT COUNT(*) FROM reservations r WHERE r.part_number = p.part_number AND r.status = 'RESERVED') as total_reserved
      FROM parts p
      ORDER BY p.part_number
    `;
    const result = await pool.query(query);
    const processed = result.rows.map(row => {
      const remaining = parseInt(row.current_seed_qty) + parseInt(row.total_refilled_received) - parseInt(row.total_used);
      const available = remaining - parseInt(row.total_reserved);
      return { ...row, remaining_stock: remaining, available_stock: available };
    });
    return processed;
  } catch (err) { return reply.code(500).send({ error: err.message }); }
});

fastify.post("/api/add-legacy-sn", async (request, reply) => {
  try {
    const { partNumber, serialNumber } = request.body;
    const query = `INSERT INTO shipment_items (awb_number, part_number, serial_number, qty, status, classification, received_at) VALUES ('LEGACY-STOCK', $1, $2, 1, 'RECEIVED', 'LEGACY_SEED', NOW())`;
    await pool.query(query, [partNumber, serialNumber]);
    return { success: true };
  } catch (err) { return reply.code(500).send({ error: err.message }); }
});

fastify.post("/api/reserve", async (request, reply) => {
  try {
    const { partNumber, customerName, deviceSn } = request.body;
    const query = `INSERT INTO reservations (part_number, customer_name, device_sn, status) VALUES ($1, $2, $3, 'RESERVED')`;
    await pool.query(query, [partNumber, customerName, deviceSn]);
    return { success: true };
  } catch (err) { return reply.code(500).send({ error: err.message }); }
});

fastify.get("/api/reservations/:part", async (request, reply) => {
  try {
    const query = `SELECT * FROM reservations WHERE part_number = $1 AND status = 'RESERVED' ORDER BY created_at ASC`;
    const result = await pool.query(query, [request.params.part]);
    return result.rows;
  } catch (err) { return reply.code(500).send({ error: err.message }); }
});

fastify.post("/api/unreserve", async (request, reply) => {
  try {
    const query = `UPDATE reservations SET status = 'FULFILLED' WHERE id = $1`;
    await pool.query(query, [request.body.id]);
    return { success: true };
  } catch (err) { return reply.code(500).send({ error: err.message }); }
});

fastify.post("/api/upload-packing-list", async (request, reply) => {
  try {
    const items = request.body.items;
    let addedCount = 0;
    for (let item of items) {
      const partQuery = `INSERT INTO parts (part_number, product, model, description, base_seed_qty) VALUES ($1, 'Unknown', 'Unknown', 'Auto-added from Packing List', 0) ON CONFLICT (part_number) DO NOTHING`;
      await pool.query(partQuery, [item.partNumber]);

      const checkQuery = `SELECT id FROM shipment_items WHERE awb_number = $1 AND part_number = $2 AND (serial_number = $3 OR (serial_number IS NULL AND $3 IS NULL))`;
      const existing = await pool.query(checkQuery, [item.awb, item.partNumber, item.serialNumber || null]);

      if (existing.rows.length === 0) {
        const query = `INSERT INTO shipment_items (awb_number, part_number, serial_number, qty, status, repair_id, po_number) VALUES ($1, $2, $3, $4, 'IN_TRANSIT', $5, $6)`;
        await pool.query(query, [item.awb, item.partNumber, item.serialNumber || null, item.qty || 1, item.repairId || null, item.poNumber || null]);
        addedCount++;
      }
    }
    return { success: true, addedCount };
  } catch (err) { return reply.code(500).send({ error: err.message }); }
});

fastify.get("/api/expected/:query", async (request, reply) => {
  try {
    const q = request.params.query;
    const query = `SELECT * FROM shipment_items WHERE status = 'IN_TRANSIT' AND (part_number = $1 OR serial_number = $1) ORDER BY created_at ASC`;
    const result = await pool.query(query, [q]);
    return result.rows;
  } catch (err) { return reply.code(500).send({ error: err.message }); }
});

fastify.post("/api/mark-received", async (request, reply) => {
  try {
    const { id, classification, serialNumber } = request.body;
    const query = `UPDATE shipment_items SET status = 'RECEIVED', classification = $1, serial_number = $2, received_at = NOW() WHERE id = $3`;
    await pool.query(query, [classification, serialNumber || null, id]);
    return { success: true };
  } catch (err) { return reply.code(500).send({ error: err.message }); }
});

fastify.get("/api/serials/:part", async (request, reply) => {
  try {
    const part = request.params.part;
    const query = `
      SELECT serial_number FROM shipment_items WHERE part_number = $1 AND status = 'RECEIVED' AND serial_number IS NOT NULL
      EXCEPT
      SELECT serial_number FROM usage_logs WHERE part_number = $1 AND serial_number IS NOT NULL
    `;
    const result = await pool.query(query, [part]);
    return result.rows.map(r => r.serial_number);
  } catch (err) { return reply.code(500).send({ error: err.message }); }
});

fastify.get("/api/identify-sn/:sn", async (request, reply) => {
  try {
    const sn = request.params.sn.trim();
    const query = `
      SELECT part_number FROM shipment_items 
      WHERE serial_number = $1 AND status = 'RECEIVED' 
      AND serial_number NOT IN (SELECT serial_number FROM usage_logs WHERE serial_number IS NOT NULL)
      LIMIT 1
    `;
    const result = await pool.query(query, [sn]);
    return result.rows[0] || { part_number: null };
  } catch (err) { return reply.code(500).send({ error: err.message }); }
});

fastify.post("/api/use", async (request, reply) => {
  try {
    const { repairId, partNumber, serialNumber, technician } = request.body;
    const query = `INSERT INTO usage_logs (repair_id, device_serial, part_number, serial_number, technician) VALUES ($1, 'UNKNOWN', $2, $3, $4)`;
    await pool.query(query, [repairId, partNumber, serialNumber || null, technician]);
    return { success: true };
  } catch (err) { return reply.code(500).send({ error: err.message }); }
});

// NEW: Bulk Usage Endpoint
fastify.post("/api/bulk-use", async (request, reply) => {
  try {
    const items = request.body.items;
    let addedCount = 0;
    for (let item of items) {
      if (!item.partNumber) continue; // Skip blank rows
      
      // Force part to exist first so database doesn't reject it
      const partQuery = `INSERT INTO parts (part_number, product, model, description, base_seed_qty) VALUES ($1, 'Unknown', 'Unknown', 'Auto-added from Bulk Usage', 0) ON CONFLICT (part_number) DO NOTHING`;
      await pool.query(partQuery, [item.partNumber.toString().trim()]);
      
      // Insert the usage log
      const query = `INSERT INTO usage_logs (repair_id, device_serial, part_number, serial_number, technician) VALUES ($1, 'UNKNOWN', $2, $3, $4)`;
      await pool.query(query, [
        item.repairId ? item.repairId.toString().trim() : 'UNKNOWN_REPAIR', 
        item.partNumber.toString().trim(), 
        item.serialNumber ? item.serialNumber.toString().trim() : null, 
        item.technician ? item.technician.toString().trim() : 'TECH'
      ]);
      addedCount++;
    }
    return { success: true, addedCount };
  } catch (err) { return reply.code(500).send({ error: err.message }); }
});

fastify.get("/api/awb-status", async (request, reply) => {
  try {
    const query = `
      SELECT awb_number, MAX(po_number) as po_number, COUNT(id) as total_parts, SUM(CASE WHEN status = 'RECEIVED' THEN 1 ELSE 0 END) as received_parts,
             json_agg(json_build_object('part', part_number, 'sn', serial_number, 'status', status, 'repair_id', repair_id, 'po_number', po_number)) as items
      FROM shipment_items GROUP BY awb_number ORDER BY MAX(created_at) DESC
    `;
    const result = await pool.query(query);
    return result.rows;
  } catch (err) { return reply.code(500).send({ error: err.message }); }
});

fastify.get("/api/received-history", async (request, reply) => {
  try {
    const query = `
      SELECT s.id, s.awb_number, s.po_number, s.repair_id, s.part_number, s.serial_number, s.classification, s.received_at, p.description, p.model 
      FROM shipment_items s LEFT JOIN parts p ON s.part_number = p.part_number
      WHERE s.status = 'RECEIVED' ORDER BY s.received_at DESC
    `;
    const result = await pool.query(query);
    return result.rows;
  } catch (err) { return reply.code(500).send({ error: err.message }); }
});

fastify.get("/api/usage-history", async (request, reply) => {
  try {
    const query = `
      SELECT u.id, u.repair_id, u.part_number, u.serial_number, u.technician, u.created_at as used_at, p.description, p.model 
      FROM usage_logs u LEFT JOIN parts p ON u.part_number = p.part_number
      ORDER BY u.created_at DESC
    `;
    const result = await pool.query(query);
    return result.rows;
  } catch (err) { return reply.code(500).send({ error: err.message }); }
});

fastify.listen({ port: 3000, host: "0.0.0.0" }, function (err, address) {
  if (err) { console.error(err); process.exit(1); }
  console.log(`Your app is listening on ${address}`);
});
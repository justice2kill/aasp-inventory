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

// Helper: Auto-detect Category & Model from Description text
function detectCategory(description) {
  if (!description) return { category: 'Unknown', model: 'Unknown' };
  const desc = description.toUpperCase();
  
  let category = 'Other';
  if (desc.includes('DISPLAY') || desc.includes('SCREEN')) category = 'Display';
  else if (desc.includes('BATTERY')) category = 'Battery';
  else if (desc.includes('CAMERA') || desc.includes('CAM')) category = 'Camera';
  else if (desc.includes('MLB') || desc.includes('LOGIC BOARD') || desc.includes('BOARD')) category = 'Logic Board';
  else if (desc.includes('ENCLOSURE') || desc.includes('TOP CASE') || desc.includes('HOUSING')) category = 'Enclosure';
  else if (desc.includes('CABLE') || desc.includes('FLEX')) category = 'Flex Cable';
  else if (desc.includes('SPEAKER') || desc.includes('AUDIO')) category = 'Audio / Speaker';
  else if (desc.includes('ADAPTER') || desc.includes('POWER')) category = 'Power / Adapter';
  else if (desc.includes('ADAPTER') || desc.includes('POWER')) category = 'Power Adapter';

  let model = 'Unknown';
  if (desc.includes('IPHONE')) model = 'iPhone';
  else if (desc.includes('MACBOOK') || desc.includes('MAC')) model = 'Mac';
  else if (desc.includes('IPAD')) model = 'iPad';
  else if (desc.includes('WATCH')) model = 'Apple Watch';
  
  return { category, model };
}

fastify.get("/api/stock", async (request, reply) => {
  try {
    const query = `
      SELECT 
        p.part_number, 
        p.product, 
        p.model, 
        p.description, 
        p.base_seed_qty as current_seed_qty,
        (SELECT COUNT(*) FROM shipment_items s WHERE s.part_number = p.part_number AND s.status = 'RECEIVED' AND (s.classification IS NULL OR s.classification::text NOT IN ('LEGACY_SEED', 'FOC'))) as total_refilled_received,
        (SELECT COUNT(*) FROM usage_logs u WHERE u.part_number = p.part_number) as total_used,
        (SELECT COUNT(*) FROM reservations r WHERE r.part_number = p.part_number AND r.status = 'RESERVED') as total_reserved,
        (SELECT COUNT(*) FROM shipment_items s WHERE s.part_number = p.part_number AND s.classification = 'FOC') as total_foc
      FROM parts p
      ORDER BY p.part_number
    `;
    const { rows } = await pool.query(query);

    const stock = rows.map(r => {
      const remaining = Number(r.current_seed_qty) + Number(r.total_refilled_received) - Number(r.total_used);
      return {
        ...r,
        remaining_stock: remaining,
        available_stock: remaining - Number(r.total_reserved)
      };
    });

    return stock;
  } catch (err) {
    return reply.code(500).send({ error: err.message });
  }
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
    
    const awbNumber = items.length > 0 ? items[0].awb : null;
    if (!awbNumber) return { success: true, addedCount: 0 };

    // Get snapshot of existing database items for this AWB
    const { rows: dbItems } = await pool.query(
      `SELECT id, part_number, serial_number, repair_id, po_number FROM shipment_items WHERE awb_number = $1`, 
      [awbNumber]
    );

    let availableDbItems = [...dbItems];

    for (let item of items) {
      // Auto-detect Category & Model if missing
      const { category, model } = detectCategory(item.description);

      // Ensure the part profile exists
      const partQuery = `
        INSERT INTO parts (part_number, product, model, description, base_seed_qty) 
        VALUES ($1, $2, $3, $4, 0) 
        ON CONFLICT (part_number) DO UPDATE 
        SET product = CASE WHEN parts.product = 'Unknown' OR parts.product IS NULL THEN EXCLUDED.product ELSE parts.product END,
            model = CASE WHEN parts.model = 'Unknown' OR parts.model IS NULL THEN EXCLUDED.model ELSE parts.model END
      `;
      await pool.query(partQuery, [item.partNumber, category, model, item.description || 'Auto-added from Packing List']);

      let matchIndex = -1;

      // 1. Strict match (Part + SN + Repair ID)
      matchIndex = availableDbItems.findIndex(db => 
        db.part_number === item.partNumber && 
        (db.serial_number === item.serialNumber || (!db.serial_number && !item.serialNumber)) &&
        (db.repair_id === item.repairId || (!db.repair_id && !item.repairId))
      );

      // 2. Fallback match (Part + Repair ID)
      if (matchIndex === -1) {
        matchIndex = availableDbItems.findIndex(db => 
          db.part_number === item.partNumber && 
          (db.repair_id === item.repairId || (!db.repair_id && !item.repairId))
        );
      }

      // 3. Final fallback (Part Number only)
      if (matchIndex === -1) {
        matchIndex = availableDbItems.findIndex(db => db.part_number === item.partNumber);
      }

      if (matchIndex !== -1) {
        const matchedDbItem = availableDbItems[matchIndex];
        
        // FORCE OVERWRITE: Fix chopped or incorrect PO numbers
        if (item.poNumber && item.poNumber !== 'N/A') {
           await pool.query(`UPDATE shipment_items SET po_number = $1 WHERE id = $2`, [item.poNumber, matchedDbItem.id]);
        }
        availableDbItems.splice(matchIndex, 1);
      } else {
        // Genuine new part insertion
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

fastify.post("/api/bulk-use", async (request, reply) => {
  try {
    const items = request.body.items;
    let addedCount = 0;
    for (let item of items) {
      if (!item.partNumber) continue; 
      const partQuery = `INSERT INTO parts (part_number, product, model, description, base_seed_qty) VALUES ($1, 'Unknown', 'Unknown', 'Auto-added from Bulk Usage', 0) ON CONFLICT (part_number) DO NOTHING`;
      await pool.query(partQuery, [item.partNumber.toString().trim()]);
      
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

// Manual Add Endpoint
fastify.post("/api/manual-add", async (request, reply) => {
  try {
    const { partNumber, serialNumber, classification, remark } = request.body;
    if (!partNumber) throw new Error("Part Number is required");

    const partQuery = `INSERT INTO parts (part_number, product, model, description, base_seed_qty) VALUES ($1, 'Unknown', 'Unknown', 'Manually Added Part', 0) ON CONFLICT (part_number) DO NOTHING`;
    await pool.query(partQuery, [partNumber.trim()]);

    const query = `INSERT INTO shipment_items (awb_number, part_number, serial_number, qty, status, classification, po_number, received_at) VALUES ('MANUAL-ADJ', $1, $2, 1, 'RECEIVED', $3, $4, NOW())`;
    await pool.query(query, [partNumber.trim(), serialNumber ? serialNumber.trim() : null, classification, remark ? remark.trim() : null]);
    
    return { success: true };
  } catch (err) { return reply.code(500).send({ error: err.message }); }
});

// Edit Part Details Endpoint (Supports Category, Model, and Description)
fastify.post("/api/update-part", async (request, reply) => {
  try {
    const { partNumber, product, model, description } = request.body;
    const query = `UPDATE parts SET product = COALESCE($1, product), model = $2, description = $3 WHERE part_number = $4`;
    await pool.query(query, [product || null, model, description, partNumber]);
    return { success: true };
  } catch (err) { return reply.code(500).send({ error: err.message }); }
});

fastify.listen({ port: 3000, host: "0.0.0.0" }, function (err, address) {
  if (err) { console.error(err); process.exit(1); }
  console.log(`Your app is listening on ${address}`);
});
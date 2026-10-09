require("dotenv").config();
const fastify = require("fastify")({ logger: false });
const path = require("path");
const { Pool } = require("@neondatabase/serverless"); 

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://neondb_owner:npg_XHzkG8nMJx2B@ep-plain-night-azr7vi9q-pooler.c-3.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
  ssl: { require: true }
});

// --- AUTO DATABASE SETUP ---
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS kbb_returns (
        id SERIAL PRIMARY KEY,
        repair_id VARCHAR(100),
        device_serial VARCHAR(100),
        part_number VARCHAR(100),
        kbb_serial VARCHAR(100),
        technician VARCHAR(100),
        return_awb VARCHAR(100),
        status VARCHAR(50) DEFAULT 'PENDING',
        remark TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        resolved_at TIMESTAMP
      );
    `);
    
    // Explicitly add missing columns to the existing table
    await pool.query(`ALTER TABLE kbb_returns ADD COLUMN IF NOT EXISTS return_awb VARCHAR(100);`);
    await pool.query(`ALTER TABLE kbb_returns ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMP;`);
    await pool.query(`ALTER TABLE kbb_returns ADD COLUMN IF NOT EXISTS remark TEXT;`);
    
    await pool.query(`ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS is_stock_deduction BOOLEAN DEFAULT TRUE;`);
    await pool.query(`ALTER TABLE usage_logs ADD COLUMN IF NOT EXISTS warranty_status VARCHAR(50);`);
    console.log("Database Schema Verified & Updated.");
  } catch(e) {
    console.error("DB Init Error:", e.message);
  }
}
initDB();

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
        (SELECT COUNT(*) FROM usage_logs u WHERE u.part_number = p.part_number AND u.is_stock_deduction = TRUE) as total_used,
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

    const { rows: dbItems } = await pool.query(`SELECT id, part_number, serial_number, repair_id, po_number FROM shipment_items WHERE awb_number = $1`, [awbNumber]);
    let availableDbItems = [...dbItems];

    for (let item of items) {
      const { category, model } = detectCategory(item.description);

      const partQuery = `
        INSERT INTO parts (part_number, product, model, description, base_seed_qty) 
        VALUES ($1, $2, $3, $4, 0) 
        ON CONFLICT (part_number) DO UPDATE 
        SET product = CASE WHEN parts.product = 'Unknown' OR parts.product IS NULL THEN EXCLUDED.product ELSE parts.product END,
            model = CASE WHEN parts.model = 'Unknown' OR parts.model IS NULL THEN EXCLUDED.model ELSE parts.model END
      `;
      await pool.query(partQuery, [item.partNumber, category, model, item.description || 'Auto-added from Packing List']);

      let matchIndex = availableDbItems.findIndex(db => 
        db.part_number === item.partNumber && 
        (db.serial_number === item.serialNumber || (!db.serial_number && !item.serialNumber)) &&
        (db.repair_id === item.repairId || (!db.repair_id && !item.repairId))
      );

      if (matchIndex === -1) {
        matchIndex = availableDbItems.findIndex(db => db.part_number === item.partNumber && (db.repair_id === item.repairId || (!db.repair_id && !item.repairId)));
      }

      if (matchIndex === -1) {
        matchIndex = availableDbItems.findIndex(db => db.part_number === item.partNumber);
      }

      if (matchIndex !== -1) {
        const matchedDbItem = availableDbItems[matchIndex];
        if (item.poNumber && item.poNumber !== 'N/A') {
           await pool.query(`UPDATE shipment_items SET po_number = $1 WHERE id = $2`, [item.poNumber, matchedDbItem.id]);
        }
        availableDbItems.splice(matchIndex, 1);
      } else {
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
      SELECT serial_number FROM usage_logs WHERE part_number = $1 AND serial_number IS NOT NULL AND is_stock_deduction = TRUE
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
      AND serial_number NOT IN (SELECT serial_number FROM usage_logs WHERE serial_number IS NOT NULL AND is_stock_deduction = TRUE)
      LIMIT 1
    `;
    const result = await pool.query(query, [sn]);
    return result.rows[0] || { part_number: null };
  } catch (err) { return reply.code(500).send({ error: err.message }); }
});

fastify.post("/api/use", async (request, reply) => {
  try {
    const { repairId, partNumber, serialNumber, kbbSerial, deviceSn, technician, warrantyStatus, isStock, usedDate } = request.body;

    const pNum = partNumber.trim();
    const rId = repairId.trim();
    const devSn = deviceSn ? deviceSn.trim() : 'UNKNOWN';
    const kgbSn = serialNumber ? serialNumber.trim() : null;
    const kbbSn = kbbSerial ? kbbSerial.trim() : kgbSn; 
    const wStat = warrantyStatus ? warrantyStatus.trim() : 'OW';
    const stockFlag = isStock === undefined ? true : isStock;
    
    // NEW: Use selected date, or default to right now
    const dbDate = usedDate ? new Date(usedDate) : new Date();

    const checkUsage = await pool.query(`SELECT id FROM usage_logs WHERE repair_id = $1 AND part_number = $2`, [rId, pNum]);
    if (checkUsage.rows.length > 0) throw new Error("This Repair ID and Part Number combination is already recorded.");

    const partRes = await pool.query(`SELECT description FROM parts WHERE part_number = $1`, [pNum]);
    let description = partRes.rows.length > 0 ? partRes.rows[0].description : '';
    const { category } = detectCategory(description);
    const isNonReturnable = category === 'Battery' || (description && description.toUpperCase().includes('BATTERY'));
    
    let kbbStatus = isNonReturnable ? 'NON_RETURNABLE' : 'PENDING';
    let kbbRemark = isNonReturnable ? 'Auto-Closed: Consumable/Battery' : null;

    // Inject dbDate into created_at
    const useQuery = `INSERT INTO usage_logs (repair_id, device_serial, part_number, serial_number, technician, is_stock_deduction, warranty_status, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;
    await pool.query(useQuery, [rId, devSn, pNum, kgbSn, technician, stockFlag, wStat, dbDate]);
    
    const checkKbb = await pool.query(`SELECT id FROM kbb_returns WHERE repair_id = $1 AND part_number = $2`, [rId, pNum]);
    if (checkKbb.rows.length === 0) {
        if (isNonReturnable) {
            await pool.query(`INSERT INTO kbb_returns (repair_id, device_serial, part_number, kbb_serial, technician, status, remark, created_at, resolved_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`, [rId, devSn, pNum, kbbSn, technician, kbbStatus, kbbRemark, dbDate]);
        } else {
            await pool.query(`INSERT INTO kbb_returns (repair_id, device_serial, part_number, kbb_serial, technician, status, created_at) VALUES ($1, $2, $3, $4, $5, 'PENDING', $6)`, [rId, devSn, pNum, kbbSn, technician, dbDate]);
        }
    }
    
    return { success: true };
  } catch (err) { return reply.code(500).send({ error: err.message }); }
});

fastify.post("/api/bulk-use", async (request, reply) => {
  try {
    const items = request.body.items;
    let addedCount = 0;
    let skippedCount = 0;
    
    for (let item of items) {
      if (!item.partNumber) continue; 
      
      const pNum = item.partNumber.toString().trim();
      const rId = item.repairId ? item.repairId.toString().trim() : 'UNKNOWN_REPAIR';
      
      const checkUsage = await pool.query(`SELECT id FROM usage_logs WHERE repair_id = $1 AND part_number = $2`, [rId, pNum]);
      if (checkUsage.rows.length > 0) {
        skippedCount++;
        continue;
      }

      const sn = item.serialNumber ? item.serialNumber.toString().trim() : null;
      const kbbSn = item.kbbSerial ? item.kbbSerial.toString().trim() : sn;
      const tech = item.technician ? item.technician.toString().trim() : 'TECH';
      const devSn = item.deviceSn ? item.deviceSn.toString().trim() : 'UNKNOWN';
      const warranty = item.warrantyStatus ? item.warrantyStatus.toString().trim() : null;
      const isStock = item.isStock === true;

      // NEW: Bulletproof Date Parser for Apple Excel Files
      let dbDate = new Date();
      if (item.usedDate) {
          if (typeof item.usedDate === 'number') {
              // Handle Raw Excel Serial Numbers (e.g., 45199)
              dbDate = new Date(Math.round((item.usedDate - 25569) * 86400 * 1000));
          } else {
              // Handle DD.MM.YYYY or DD/MM/YYYY
              let dateStr = String(item.usedDate).trim();
              
              // If it looks like European/Asian format (e.g., 30.09.2026 or 30/09/2026)
              const euroFormat = dateStr.match(/^(\d{1,2})[\.\/ -](\d{1,2})[\.\/ -](\d{4})$/);
              if (euroFormat) {
                  // Rebuild it as YYYY-MM-DD so JS can read it perfectly
                  dateStr = `${euroFormat[3]}-${euroFormat[2].padStart(2, '0')}-${euroFormat[1].padStart(2, '0')}`;
              }
              
              const pDate = new Date(dateStr);
              if (!isNaN(pDate)) dbDate = pDate;
          }
      }

      const { category } = detectCategory(item.description);
      const isNonReturnable = category === 'Battery' || (item.description && item.description.toUpperCase().includes('BATTERY'));
      
      let kbbStatus = isNonReturnable ? 'NON_RETURNABLE' : 'PENDING';
      let kbbRemark = isNonReturnable ? 'Auto-Closed: Consumable/Battery' : null;

      await pool.query(
        `INSERT INTO parts (part_number, product, model, description, base_seed_qty) 
         VALUES ($1, 'Unknown', 'Unknown', 'Auto-added from Bulk Usage', 0) 
         ON CONFLICT (part_number) DO NOTHING`, 
        [pNum]
      );
      
      await pool.query(
        `INSERT INTO usage_logs (repair_id, device_serial, part_number, serial_number, technician, is_stock_deduction, warranty_status, created_at) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, 
        [rId, devSn, pNum, sn, tech, isStock, warranty, dbDate]
      );
      
      const checkKbb = await pool.query(`SELECT id FROM kbb_returns WHERE repair_id = $1 AND part_number = $2`, [rId, pNum]);
      if (checkKbb.rows.length === 0) {
        if (isNonReturnable) {
          await pool.query(
            `INSERT INTO kbb_returns (repair_id, device_serial, part_number, kbb_serial, technician, status, remark, created_at, resolved_at) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`, 
            [rId, devSn, pNum, kbbSn, tech, kbbStatus, kbbRemark, dbDate]
          );
        } else {
          await pool.query(
            `INSERT INTO kbb_returns (repair_id, device_serial, part_number, kbb_serial, technician, status, created_at) 
             VALUES ($1, $2, $3, $4, $5, 'PENDING', $6)`, 
            [rId, devSn, pNum, kbbSn, tech, dbDate]
          );
        }
      }
      
      addedCount++;
    }
    return { success: true, addedCount, skippedCount };
  } catch (err) { return reply.code(500).send({ error: err.message }); }
});

fastify.get("/api/kbb", async (request, reply) => {
  try {
    const { rows } = await pool.query(`
      SELECT 
        k.id,
        k.repair_id,
        k.device_serial,
        k.part_number,
        u.serial_number AS good_serial,
        k.kbb_serial,
        k.technician,
        k.return_awb,
        k.status,
        k.remark,
        k.created_at,
        k.resolved_at,
        p.description 
      FROM kbb_returns k 
      LEFT JOIN parts p ON k.part_number = p.part_number 
      LEFT JOIN usage_logs u ON k.repair_id = u.repair_id AND k.part_number = u.part_number
      ORDER BY k.created_at DESC
    `);
    return rows;
  } catch (err) { return reply.code(500).send({ error: err.message }); }
});

fastify.post('/api/kbb/return', async (request, reply) => {
  const { id, kbbSerial, returnAwb } = request.body;
  try {
      await pool.query(
          `UPDATE kbb_returns 
           SET kbb_serial = $1, return_awb = $2, status = 'SHIPPED', resolved_at = CURRENT_TIMESTAMP 
           WHERE id = $3`,
          [kbbSerial || null, returnAwb || null, id]
      );
      return { success: true };
  } catch (error) {
      console.error("KBB Return Error:", error.message);
      reply.code(500).send({ error: error.message }); 
  }
});

fastify.post('/api/kbb/close', async (request, reply) => {
  const { id, remark } = request.body;
  try {
      await pool.query(
          `UPDATE kbb_returns 
           SET remark = $1, status = 'CLOSED', resolved_at = CURRENT_TIMESTAMP 
           WHERE id = $2`,
          [remark, id]
      );
      return { success: true };
  } catch (error) {
      console.error("KBB Close Error:", error.message);
      reply.code(500).send({ error: error.message });
  }
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
      SELECT u.id, u.repair_id, u.device_serial, u.part_number, u.serial_number, u.technician, u.is_stock_deduction, u.warranty_status, u.created_at as used_at, p.description, p.model,
             (SELECT kbb_serial FROM kbb_returns k WHERE k.repair_id = u.repair_id AND k.part_number = u.part_number LIMIT 1) as kbb_serial
      FROM usage_logs u LEFT JOIN parts p ON u.part_number = p.part_number
      ORDER BY u.created_at DESC
    `;
    const result = await pool.query(query);
    return result.rows;
  } catch (err) { return reply.code(500).send({ error: err.message }); }
});

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

fastify.post("/api/update-part", async (request, reply) => {
  try {
    const { partNumber, product, model, description } = request.body;
    const query = `UPDATE parts SET product = COALESCE($1, product), model = $2, description = $3 WHERE part_number = $4`;
    await pool.query(query, [product || null, model, description, partNumber]);
    return { success: true };
  } catch (err) { return reply.code(500).send({ error: err.message }); }
});

// Start the server (Compatible with both local StackBlitz and Vercel Serverless)
if (process.env.VERCEL) {
  module.exports = async (req, res) => {
    await fastify.ready();
    fastify.server.emit('request', req, res);
  };
} else {
  fastify.listen({ port: process.env.PORT || 3000, host: '0.0.0.0' }, (err, address) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }
    console.log(`Server listening at ${address}`);
  });
}
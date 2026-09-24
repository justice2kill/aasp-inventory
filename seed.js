const { Pool } = require("@neondatabase/serverless");
const XLSX = require("xlsx");

const pool = new Pool({
  connectionString: "postgresql://neondb_owner:npg_XHzkG8nMJx2B@ep-plain-night-azr7vi9q-pooler.c-3.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
  ssl: { require: true }
});

async function run() {
  console.log("Reading STOCK LIST.xlsx...");
  const workbook = XLSX.readFile("STOCK LIST.xlsx");
  const sheetName = workbook.SheetNames.find(n => n.includes("Stock List"));
  const data = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

  console.log(`Found ${data.length} rows. Wiping old data...`);
  await pool.query("TRUNCATE TABLE usage_logs, reservations, shipment_items RESTART IDENTITY CASCADE;");
  await pool.query("TRUNCATE TABLE parts RESTART IDENTITY CASCADE;");

  console.log("Aggregating base quantities...");
  const partsMap = {};
  data.forEach(row => {
    const pNum = (row["Part Number"] || "").toString().trim();
    if (!pNum) return;
    if (!partsMap[pNum]) {
      partsMap[pNum] = {
        model: row["Model"] || "Unknown",
        desc: row["Part Description"] || "Unknown",
        qty: 0,
        serials: []
      };
    }
    partsMap[pNum].qty += 1;
    
    const sn = (row["S/N:"] || "").toString().trim();
    if (sn && sn.toLowerCase() !== "nan") {
      partsMap[pNum].serials.push(sn);
    }
  });

  console.log("Inserting baseline parts into database...");
  for (const [pNum, details] of Object.entries(partsMap)) {
    await pool.query(`INSERT INTO parts (part_number, product, model, description, base_seed_qty) VALUES ($1, 'Unknown', $2, $3, $4)`, [pNum, details.model, details.desc, details.qty]);
    
    for (const sn of details.serials) {
      await pool.query(`INSERT INTO shipment_items (awb_number, part_number, serial_number, qty, status, classification, received_at) VALUES ('LEGACY-STOCK', $1, $2, 1, 'RECEIVED', 'LEGACY_SEED', NOW())`, [pNum, sn]);
    }
  }

  console.log("✅ Database successfully wiped and seeded!");
  process.exit(0);
}

run().catch(console.error);
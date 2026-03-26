const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const app = express();

// ─── MIDDLEWARES ────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ─── CONFIGURACIÓN DE CONEXIÓN ──────────────────────────────
// Se añade ssl: { rejectUnauthorized: false } de forma robusta
const pool = new Pool({ 
  connectionString: process.env.DATABASE_URL, 
  ssl: { 
    rejectUnauthorized: false 
  } 
});

const JWT_SECRET = process.env.JWT_SECRET || 'esenciafut-secret-local';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'esenciafut2025';

// Precios de referencia
const PATCH_PRICE  = 0.86;
const DORSAL_PRICE = 1.71;
const COST_MAP     = { fan: 28.00, player: 30.00, retro: 30.00 };

// ─── FUNCIÓN AUTO-INSTALADORA (SQL) ─────────────────────────
const setupDatabase = async () => {
  try {
    const sqlPath = path.join(__dirname, 'schema.sql');
    if (fs.existsSync(sqlPath)) {
      const sql = fs.readFileSync(sqlPath, 'utf8');
      await pool.query(sql);
      console.log("✅ Base de datos: Tablas verificadas/creadas correctamente.");
    } else {
      console.log("⚠️ No se encontró schema.sql en la raíz del backend.");
    }
  } catch (err) {
    // Si el error es de certificado, intentamos informar pero no detenemos el servidor
    console.error("❌ Error en setupDatabase:", err.message);
  }
};

// ─── MIDDLEWARE DE AUTENTICACIÓN ────────────────────────────
function auth(req, res, next) {
  const header = req.headers['authorization'];
  if (!header) return res.status(401).json({ error: 'No autorizado' });
  try {
    req.user = jwt.verify(header.replace('Bearer ', ''), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
}

// ─── RUTAS DE SALUD Y AUTH ──────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true, database: 'connected' }));

app.post('/api/login', (req, res) => {
  if (req.body.password !== ADMIN_PASS)
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  const token = jwt.sign({ admin: true }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token });
});

// ─── CATÁLOGO PÚBLICO ───────────────────────────────────────
app.get('/api/catalog', async (req, res) => {
  try {
    const { search, competition_id, team_id } = req.query;
    const where = [`p.status = 'active'`];
    const params = [];

    if (search) { 
      params.push(`%${search}%`); 
      where.push(`(p.name ILIKE $${params.length} OR t.name ILIKE $${params.length})`); 
    }
    if (competition_id) { 
      params.push(competition_id); 
      where.push(`t.competition_id = $${params.length}`); 
    }
    if (team_id) { 
      params.push(team_id); 
      where.push(`p.team_id = $${params.length}`); 
    }

    const query = `
      SELECT p.id, p.name, p.season, p.kit_type, p.version_type, p.section_type, p.cost, p.description,
             t.name AS team_name, c.name AS competition_name, c.id AS competition_id,
             (SELECT path FROM product_images WHERE product_id = p.id ORDER BY position LIMIT 1) AS image
      FROM products p
      LEFT JOIN teams t ON t.id = p.team_id
      LEFT JOIN competitions c ON c.id = t.competition_id
      WHERE ${where.join(' AND ')}
      ORDER BY p.created_at DESC
    `;
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/competitions', async (_, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM competitions WHERE active=true ORDER BY name`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/teams/:cid', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name FROM teams WHERE competition_id=$1 AND active=true ORDER BY name`,
      [req.params.cid]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GESTIÓN DE PRODUCTOS (ADMIN) ───────────────────────────
app.get('/api/products', auth, async (req, res) => {
  try {
    const { search } = req.query;
    const params = [];
    let extraWhere = '';
    if (search) { 
      params.push(`%${search}%`); 
      extraWhere = `WHERE p.name ILIKE $1 OR t.name ILIKE $1`; 
    }

    const { rows } = await pool.query(`
      SELECT p.*, t.name AS team_name, c.name AS competition_name,
             (SELECT path FROM product_images WHERE product_id=p.id ORDER BY position LIMIT 1) AS image,
             (SELECT COUNT(*) FROM inventories WHERE product_id=p.id AND is_sold=false)::int AS stock
      FROM products p
      LEFT JOIN teams t ON t.id=p.team_id
      LEFT JOIN competitions c ON c.id=t.competition_id
      ${extraWhere}
      ORDER BY p.created_at DESC
    `, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/products', auth, async (req, res) => {
  try {
    const { team_id, season_id, season, sku, name, description, status,
            section_type, kit_type, version_type, supplier_id,
            supplier_product_name, cost, image_url } = req.body;

    const finalCost = cost ?? COST_MAP[version_type] ?? 28.00;
    const slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

    const { rows } = await pool.query(`
      INSERT INTO products (team_id,season_id,season,sku,name,slug,description,status,
        section_type,kit_type,version_type,supplier_id,supplier_product_name,cost,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW(),NOW()) RETURNING *`,
      [team_id, season_id||null, season||null, sku||null, name, slug, description||null,
       status||'active', section_type||null, kit_type||null, version_type||null,
       supplier_id||null, supplier_product_name||null, finalCost]
    );
    if (image_url) {
      await pool.query(
        `INSERT INTO product_images (product_id,path,position,alt_text,created_at,updated_at) VALUES ($1,$2,0,$3,NOW(),NOW())`,
        [rows[0].id, image_url, name]
      );
    }
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── INVENTARIO Y VENTAS ────────────────────────────────────
app.post('/api/inventory', auth, async (req, res) => {
  try {
    const { product_id, supplier_product_name, size, quantity=1,
            cost_price, patches_qty=0, patches_description,
            has_dorsal=false, dorsal_name, dorsal_number } = req.body;

    const total = parseFloat(cost_price) + (patches_qty * PATCH_PRICE) + (has_dorsal ? DORSAL_PRICE : 0);
    const created = [];
    for (let i = 0; i < quantity; i++) {
      const { rows } = await pool.query(`
        INSERT INTO inventories (product_id,supplier_product_name,size,cost_price,
          patches_qty,patches_description,has_dorsal,dorsal_name,dorsal_number,
          total_computed_cost,is_sold,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false,NOW(),NOW()) RETURNING *`,
        [product_id||null, supplier_product_name||null, size, cost_price,
         patches_qty, patches_description||null, has_dorsal,
         dorsal_name||null, dorsal_number||null, total]
      );
      created.push(rows[0]);
    }
    res.status(201).json(created);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sales', auth, async (req, res) => {
  try {
    const { inventory_id, sale_price, seller_name, commission=0 } = req.body;
    const { rows: inv } = await pool.query(
      `SELECT i.*,p.name AS product_name FROM inventories i LEFT JOIN products p ON p.id=i.product_id WHERE i.id=$1`,
      [inventory_id]
    );
    if (!inv.length) return res.status(404).json({ error: 'No encontrado' });
    const item = inv[0];
    const cost = parseFloat(item.cost_price);
    const sp   = parseFloat(sale_price);
    const comm = parseFloat(commission);
    const companyProfit = sp - cost - comm;

    const { rows } = await pool.query(`
      INSERT INTO sales (inventory_id,product_id,supplier_product_name,cost_price,
        sale_price,seller_name,seller_commission,company_profit,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW()) RETURNING *`,
      [inventory_id, item.product_id,
       `${item.product_name||'Producto'} (Talla ${item.size})`,
       cost, sp, seller_name, comm, companyProfit]
    );
    await pool.query(`UPDATE inventories SET is_sold=true,updated_at=NOW() WHERE id=$1`, [inventory_id]);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── ESTADÍSTICAS ───────────────────────────────────────────
app.get('/api/stats', auth, async (_, res) => {
  try {
    const [stock, investment, recovered, profit, commissions, sellers] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS v FROM inventories WHERE is_sold=false`),
      pool.query(`SELECT COALESCE(SUM(total_computed_cost),0)::float AS v FROM inventories WHERE is_sold=false`),
      pool.query(`SELECT COALESCE(SUM(total_computed_cost),0)::float AS v FROM inventories WHERE is_sold=true`),
      pool.query(`SELECT COALESCE(SUM(company_profit),0)::float AS v FROM sales`),
      pool.query(`SELECT COALESCE(SUM(seller_commission),0)::float AS v FROM sales`),
      pool.query(`SELECT seller_name, SUM(sale_price)::float AS total_ventas, SUM(seller_commission)::float AS total_comm FROM sales WHERE seller_name IS NOT NULL GROUP BY seller_name ORDER BY total_ventas DESC`),
    ]);
    res.json({
      stock:       stock.rows[0].v,
      investment:  investment.rows[0].v,
      recovered:   recovered.rows[0].v,
      profit:      profit.rows[0].v,
      commissions: commissions.rows[0].v,
      sellers:     sellers.rows,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── ARRANQUE DEL SERVIDOR ──────────────────────────────────
const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
  console.log(`🚀 Esencia Fut API activa en puerto ${PORT}`);
  await setupDatabase();
});
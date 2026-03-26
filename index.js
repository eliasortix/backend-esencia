const express = require('express');
const cors    = require('cors');
const jwt     = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

// ─── CONFIG ────────────────────────────────────────────────
const pool      = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const JWT_SECRET = process.env.JWT_SECRET || 'esenciafut-secret-local';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'esenciafut2025';  // ← cámbiala en Render

// Costes extras (igual que tu Laravel)
const PATCH_PRICE  = 0.86;
const DORSAL_PRICE = 1.71;
const COST_MAP     = { fan: 28.00, player: 30.00, retro: 30.00 };

// ─── AUTH MIDDLEWARE ────────────────────────────────────────
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

// ─── HEALTH ─────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true }));

// ═══════════════════════════════════════════════════════════
//  AUTH
// ═══════════════════════════════════════════════════════════

// POST /api/login  { password }
app.post('/api/login', (req, res) => {
  if (req.body.password !== ADMIN_PASS)
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  const token = jwt.sign({ admin: true }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token });
});

// ═══════════════════════════════════════════════════════════
//  PÚBLICO — CATÁLOGO
// ═══════════════════════════════════════════════════════════

// GET /api/catalog?search=&competition_id=&team_id=
app.get('/api/catalog', async (req, res) => {
  try {
    const { search, competition_id, team_id } = req.query;
    const where = [`p.status = 'active'`];
    const params = [];

    if (search)         { params.push(`%${search}%`);    where.push(`(p.name ILIKE $${params.length} OR t.name ILIKE $${params.length})`); }
    if (competition_id) { params.push(competition_id);   where.push(`t.competition_id = $${params.length}`); }
    if (team_id)        { params.push(team_id);           where.push(`p.team_id = $${params.length}`); }

    const { rows } = await pool.query(`
      SELECT p.id, p.name, p.season, p.kit_type, p.version_type, p.section_type, p.cost, p.description,
             t.name AS team_name, c.name AS competition_name, c.id AS competition_id,
             (SELECT path FROM product_images WHERE product_id = p.id ORDER BY position LIMIT 1) AS image
      FROM products p
      LEFT JOIN teams t ON t.id = p.team_id
      LEFT JOIN competitions c ON c.id = t.competition_id
      WHERE ${where.join(' AND ')}
      ORDER BY p.created_at DESC
    `, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/competitions
app.get('/api/competitions', async (_, res) => {
  const { rows } = await pool.query(`SELECT * FROM competitions WHERE active=true ORDER BY name`);
  res.json(rows);
});

// GET /api/teams/:competition_id
app.get('/api/teams/:cid', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name FROM teams WHERE competition_id=$1 AND active=true ORDER BY name`,
    [req.params.cid]
  );
  res.json(rows);
});

// GET /api/seasons
app.get('/api/seasons', async (_, res) => {
  const { rows } = await pool.query(`SELECT * FROM seasons WHERE active=true ORDER BY sort_order DESC`);
  res.json(rows);
});

// GET /api/suppliers
app.get('/api/suppliers', async (_, res) => {
  const { rows } = await pool.query(`SELECT * FROM suppliers ORDER BY name`);
  res.json(rows);
});

// ═══════════════════════════════════════════════════════════
//  ADMIN — PRODUCTOS
// ═══════════════════════════════════════════════════════════

// GET /api/products?search=
app.get('/api/products', auth, async (req, res) => {
  try {
    const { search } = req.query;
    const params = [];
    let extraWhere = '';
    if (search) { params.push(`%${search}%`); extraWhere = `WHERE p.name ILIKE $1 OR t.name ILIKE $1`; }

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

// POST /api/products
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

// PUT /api/products/:id
app.put('/api/products/:id', auth, async (req, res) => {
  try {
    const { team_id, season_id, season, name, description, status,
            section_type, kit_type, version_type, supplier_id,
            supplier_product_name, cost, image_url } = req.body;

    const finalCost = cost ?? COST_MAP[version_type] ?? 28.00;
    const { rows } = await pool.query(`
      UPDATE products SET team_id=$1,season_id=$2,season=$3,name=$4,description=$5,
        status=$6,section_type=$7,kit_type=$8,version_type=$9,supplier_id=$10,
        supplier_product_name=$11,cost=$12,updated_at=NOW()
      WHERE id=$13 RETURNING *`,
      [team_id, season_id||null, season||null, name, description||null,
       status||'active', section_type||null, kit_type||null, version_type||null,
       supplier_id||null, supplier_product_name||null, finalCost, req.params.id]
    );
    if (image_url) {
      await pool.query(`DELETE FROM product_images WHERE product_id=$1`, [req.params.id]);
      await pool.query(
        `INSERT INTO product_images (product_id,path,position,alt_text,created_at,updated_at) VALUES ($1,$2,0,$3,NOW(),NOW())`,
        [req.params.id, image_url, name]
      );
    }
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/products/:id
app.delete('/api/products/:id', auth, async (req, res) => {
  try {
    await pool.query(`DELETE FROM product_images WHERE product_id=$1`, [req.params.id]);
    await pool.query(`DELETE FROM products WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
//  ADMIN — INVENTARIO
// ═══════════════════════════════════════════════════════════

// GET /api/inventory?sold=false&search=
app.get('/api/inventory', auth, async (req, res) => {
  try {
    const { search, sold } = req.query;
    const where = []; const params = [];
    if (sold !== undefined) { params.push(sold === 'true'); where.push(`i.is_sold=$${params.length}`); }
    if (search) { params.push(`%${search}%`); where.push(`(p.name ILIKE $${params.length} OR i.size ILIKE $${params.length} OR i.dorsal_name ILIKE $${params.length})`); }
    const { rows } = await pool.query(`
      SELECT i.*, p.name AS product_name, p.supplier_product_name AS product_supplier
      FROM inventories i
      LEFT JOIN products p ON p.id=i.product_id
      ${where.length ? 'WHERE '+where.join(' AND ') : ''}
      ORDER BY i.created_at DESC
    `, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/inventory  (quantity para bulk)
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

// DELETE /api/inventory/:id
app.delete('/api/inventory/:id', auth, async (req, res) => {
  try {
    await pool.query(`DELETE FROM inventories WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
//  ADMIN — VENTAS
// ═══════════════════════════════════════════════════════════

// GET /api/sales?search=
app.get('/api/sales', auth, async (req, res) => {
  try {
    const { search } = req.query;
    const params = []; let extra = '';
    if (search) { params.push(`%${search}%`); extra = `WHERE s.supplier_product_name ILIKE $1 OR s.seller_name ILIKE $1`; }
    const { rows } = await pool.query(`
      SELECT s.*, p.name AS product_name
      FROM sales s LEFT JOIN products p ON p.id=s.product_id
      ${extra} ORDER BY s.created_at DESC
    `, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/sales  { inventory_id, sale_price, seller_name, commission }
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

// DELETE /api/sales/:id  — devuelve al stock
app.delete('/api/sales/:id', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM sales WHERE id=$1`, [req.params.id]);
    if (rows.length && rows[0].inventory_id) {
      await pool.query(`UPDATE inventories SET is_sold=false,updated_at=NOW() WHERE id=$1`, [rows[0].inventory_id]);
    }
    await pool.query(`DELETE FROM sales WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
//  ADMIN — PEDIDOS
// ═══════════════════════════════════════════════════════════

// GET /api/orders
app.get('/api/orders', auth, async (req, res) => {
  try {
    const { search } = req.query;
    const params = []; let extra = '';
    if (search) { params.push(`%${search}%`); extra = `WHERE product_name ILIKE $1 OR supplier_product_name ILIKE $1`; }
    const { rows } = await pool.query(`SELECT * FROM orders ${extra} ORDER BY created_at DESC`, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/orders  — crea pedido + genera stock
app.post('/api/orders', auth, async (req, res) => {
  try {
    const { product_id, manual_product_name, supplier_product_name,
            size, quantity=1, cost_price } = req.body;

    let finalName = manual_product_name || 'Producto Manual';
    let productId = product_id || null;
    if (productId) {
      const { rows } = await pool.query(`SELECT name FROM products WHERE id=$1`, [productId]);
      if (rows.length) finalName = rows[0].name;
    }

    const { rows: order } = await pool.query(`
      INSERT INTO orders (product_id,product_name,supplier_product_name,cost_price,is_available,created_at,updated_at)
      VALUES ($1,$2,$3,$4,true,NOW(),NOW()) RETURNING *`,
      [productId, `${finalName} — Talla ${size}`, supplier_product_name||finalName, cost_price]
    );

    for (let i = 0; i < quantity; i++) {
      await pool.query(`
        INSERT INTO inventories (product_id,size,cost_price,supplier_product_name,total_computed_cost,is_sold,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$3,false,NOW(),NOW())`,
        [productId, size, cost_price, supplier_product_name||finalName]
      );
    }
    res.status(201).json(order[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/orders/:id
app.delete('/api/orders/:id', auth, async (req, res) => {
  try {
    await pool.query(`DELETE FROM orders WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
//  ADMIN — STATS
// ═══════════════════════════════════════════════════════════

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

// ─── START ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Esencia Fut API · puerto ${PORT}`));

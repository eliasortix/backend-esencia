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

// ─── CONFIGURACIÓN DE CONEXIÓN (AIVEN / RENDER) ──────────────
const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL, 
    ssl: { 
        rejectUnauthorized: false 
    } 
});

const JWT_SECRET = process.env.JWT_SECRET || 'esenciafut-secret-2026';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'esenciafut2025';

// Precios y Costes
const PATCH_PRICE  = 0.86;
const DORSAL_PRICE = 1.71;
const COST_MAP     = { fan: 28.00, player: 30.00, retro: 30.00 };

// ─── MIDDLEWARE DE AUTENTICACIÓN ────────────────────────────
function auth(req, res, next) {
    const header = req.headers['authorization'];
    if (!header) return res.status(401).json({ error: 'No autorizado' });
    try {
        const token = header.startsWith('Bearer ') ? header.slice(7) : header;
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch (err) {
        res.status(401).json({ error: 'Sesión expirada o inválida' });
    }
}

// ─── RUTAS DE SALUD Y LOGIN ─────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true, database: 'connected' }));

app.post('/api/login', (req, res) => {
    if (req.body.password !== ADMIN_PASS)
        return res.status(401).json({ error: 'Contraseña incorrecta' });
    const token = jwt.sign({ admin: true }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token });
});

// ─── CATÁLOGO PÚBLICO (FRONTEND) ─────────────────────────────
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
  SELECT 
    p.id, 
    p.name, 
    p.kit_type, 
    p.version_type, 
    p.section_type, 
    p.cost, 
    p.description,
    t.name AS team_name, 
    c.name AS competition_name, 
    s.name AS season_name, -- Aquí traemos el nombre real de la temporada
    (SELECT path FROM product_images WHERE product_id = p.id ORDER BY position LIMIT 1) AS image
  FROM products p
  LEFT JOIN teams t ON t.id = p.team_id
  LEFT JOIN competitions c ON c.id = t.competition_id
  LEFT JOIN seasons s ON s.id = p.season_id -- Unimos con la tabla de temporadas
  WHERE ${where.join(' AND ')}
  ORDER BY p.created_at DESC
`;
        const { rows } = await pool.query(query, params);
        res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GESTIÓN DE PRODUCTOS (ADMIN) ───────────────────────────
app.get('/api/products', auth, async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT p.*, t.name AS team_name, c.name AS competition_name, s.name AS season_name,
                   (SELECT path FROM product_images WHERE product_id=p.id ORDER BY position LIMIT 1) AS image_url,
                   (SELECT COUNT(*) FROM inventories WHERE product_id=p.id AND is_sold=false)::int AS stock
            FROM products p
            LEFT JOIN teams t ON t.id=p.team_id
            LEFT JOIN competitions c ON c.id=t.competition_id
            LEFT JOIN seasons s ON s.id=p.season_id
            ORDER BY p.created_at DESC
        `);
        res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/products', auth, async (req, res) => {
    try {
        const { team_id, season_id, name, description, status, section_type, kit_type, version_type, supplier_product_name, cost, image_url } = req.body;
        const finalCost = cost || COST_MAP[version_type] || 28.00;
        const slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

        const { rows } = await pool.query(`
            INSERT INTO products (team_id, season_id, name, slug, description, status, section_type, kit_type, version_type, supplier_product_name, cost, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW()) RETURNING *`,
            [team_id, season_id, name, slug, description, status || 'active', section_type, kit_type, version_type, supplier_product_name, finalCost]
        );

        if (image_url) {
            await pool.query(`INSERT INTO product_images (product_id, path, position, created_at) VALUES ($1, $2, 0, NOW())`, [rows[0].id, image_url]);
        }
        res.status(201).json(rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── INVENTARIO ─────────────────────────────────────────────
app.get('/api/inventory', auth, async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT i.*, p.name AS product_name 
            FROM inventories i 
            LEFT JOIN products p ON p.id = i.product_id 
            WHERE i.is_sold = false 
            ORDER BY i.created_at DESC
        `);
        res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/inventory', auth, async (req, res) => {
    try {
        const { product_id, size, quantity=1, cost_price, patches_qty=0, has_dorsal=false, dorsal_name, dorsal_number } = req.body;
        const total = parseFloat(cost_price) + (patches_qty * PATCH_PRICE) + (has_dorsal ? DORSAL_PRICE : 0);
        
        for (let i = 0; i < quantity; i++) {
            await pool.query(`
                INSERT INTO inventories (product_id, size, cost_price, patches_qty, has_dorsal, dorsal_name, dorsal_number, total_computed_cost, is_sold, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, NOW())`,
                [product_id, size, cost_price, patches_qty, has_dorsal, dorsal_name, dorsal_number, total]
            );
        }
        res.status(201).json({ message: 'Stock añadido' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── ESTADÍSTICAS ───────────────────────────────────────────
app.get('/api/stats', auth, async (_, res) => {
    try {
        const [inv, sales] = await Promise.all([
            pool.query(`SELECT COUNT(*)::int AS stock, COALESCE(SUM(total_computed_cost),0)::float AS investment FROM inventories WHERE is_sold=false`),
            pool.query(`SELECT COUNT(*)::int AS count, COALESCE(SUM(sale_price),0)::float AS revenue, COALESCE(SUM(company_profit),0)::float AS profit FROM sales`)
        ]);
        res.json({
            total_inv: inv.rows[0].stock,
            total_sales: sales.rows[0].count,
            revenue: sales.rows[0].revenue,
            profit: sales.rows[0].profit,
            investment: inv.rows[0].investment
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── DATOS AUXILIARES ───────────────────────────────────────
app.get('/api/competitions', async (_, res) => {
    const { rows } = await pool.query(`SELECT * FROM competitions WHERE active=true ORDER BY name`);
    res.json(rows);
});

app.get('/api/seasons', async (_, res) => {
    const { rows } = await pool.query(`SELECT * FROM seasons ORDER BY name DESC`);
    res.json(rows);
});

// ─── ARRANQUE ───────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Servidor en puerto ${PORT}`));
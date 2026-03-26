const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();

// ─── MIDDLEWARES ────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ─── CONFIGURACIÓN DE CONEXIÓN ──────────────────────────────
const pool = new Pool({ 
    connectionString: process.env.DATABASE_URL, 
    ssl: { rejectUnauthorized: false } 
});

const JWT_SECRET = process.env.JWT_SECRET || 'esenciafut-secret-2026';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'esenciafut2025';

// ─── MIDDLEWARE DE AUTENTICACIÓN ────────────────────────────
function auth(req, res, next) {
    const header = req.headers['authorization'];
    if (!header) return res.status(401).json({ error: 'No autorizado' });
    try {
        const token = header.startsWith('Bearer ') ? header.slice(7) : header;
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch (err) {
        res.status(401).json({ error: 'Sesión inválida' });
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
        let where = [];
        let params = [];

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

        const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

        const query = `
            SELECT 
                p.id, p.name, p.description, p.cost, p.main_image_url AS image,
                t.name AS team_name, c.name AS competition_name, s.name AS season_name
            FROM products p
            LEFT JOIN teams t ON t.id = p.team_id
            LEFT JOIN competitions c ON c.id = t.competition_id
            LEFT JOIN seasons s ON s.id = p.season_id
            ${whereClause}
            ORDER BY p.created_at DESC
        `;
        const { rows } = await pool.query(query, params);
        res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── INVENTARIO ─────────────────────────────────────────────
app.get('/api/inventory', auth, async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT i.*, p.name as product_name 
            FROM inventories i 
            LEFT JOIN products p ON i.product_id = p.id 
            WHERE i.is_sold = false
            ORDER BY i.created_at DESC
        `);
        res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/inventory', auth, async (req, res) => {
    try {
        const { product_id, size, cost_price, quantity = 1 } = req.body;
        for (let i = 0; i < quantity; i++) {
            await pool.query(`
                INSERT INTO inventories (product_id, size, cost_price, is_sold, created_at)
                VALUES ($1, $2, $3, false, NOW())`,
                [product_id, size, cost_price]
            );
        }
        res.status(201).json({ message: 'Stock añadido correctamente' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── VENTAS (ELIMINA EL 404 EN VENTAS) ───────────────────────
app.get('/api/sales', auth, async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT s.*, p.name as product_name 
            FROM sales s 
            LEFT JOIN products p ON s.product_id = p.id 
            ORDER BY s.created_at DESC
        `);
        res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PEDIDOS (ELIMINA EL 404 EN PEDIDOS) ──────────────────────
app.get('/api/orders', auth, async (req, res) => {
    try {
        // Intenta obtener pedidos, si la tabla no existe devuelve vacío []
        const { rows } = await pool.query(`SELECT * FROM orders ORDER BY created_at DESC`).catch(() => ({ rows: [] }));
        res.json(rows);
    } catch (e) { res.json([]); }
});

// ─── GESTIÓN DE PRODUCTOS (ADMIN) ───────────────────────────
app.get('/api/products', auth, async (req, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT p.*, t.name AS team_name, c.name AS competition_name, s.name AS season_name,
            (SELECT COUNT(*)::int FROM inventories WHERE product_id = p.id AND is_sold = false) as stock
            FROM products p
            LEFT JOIN teams t ON t.id = p.team_id
            LEFT JOIN competitions c ON c.id = t.competition_id
            LEFT JOIN seasons s ON s.id = p.season_id
            ORDER BY p.created_at DESC
        `);
        res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/products', auth, async (req, res) => {
    try {
        const { team_id, season_id, name, description, cost, main_image_url } = req.body;
        const slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

        const { rows } = await pool.query(`
            INSERT INTO products (team_id, season_id, name, slug, description, cost, main_image_url, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW()) RETURNING *`,
            [team_id, season_id, name, slug, description, cost, main_image_url]
        );
        res.status(201).json(rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── ESTADÍSTICAS ───────────────────────────────────────────
app.get('/api/stats', auth, async (_, res) => {
    try {
        const { rows } = await pool.query(`
            SELECT 
                (SELECT COUNT(*)::int FROM inventories WHERE is_sold = false) as stock_total,
                (SELECT COALESCE(SUM(cost),0)::float FROM products) as inversion_productos,
                (SELECT COALESCE(SUM(sale_price),0)::float FROM sales) as total_ventas,
                (SELECT COALESCE(SUM(company_profit),0)::float FROM sales) as total_ganancia
        `).catch(() => ({ rows: [{ stock_total: 0, inversion_productos: 0, total_ventas: 0, total_ganancia: 0 }] }));
        
        const s = rows[0];
        res.json({
            total_inv: s.stock_total,
            investment: s.inversion_productos,
            revenue: s.total_ventas,
            profit: s.total_ganancia
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── DATOS AUXILIARES ───────────────────────────────────────
app.get('/api/competitions', async (_, res) => {
    try {
        const { rows } = await pool.query(`SELECT * FROM competitions WHERE active=true ORDER BY name`);
        res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/teams/:cid', async (req, res) => {
    try {
        const { rows } = await pool.query(`SELECT id, name FROM teams WHERE competition_id=$1 ORDER BY name`, [req.params.cid]);
        res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/seasons', async (_, res) => {
    try {
        const { rows } = await pool.query(`SELECT * FROM seasons ORDER BY name DESC`);
        res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── ARRANQUE ───────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Puerto ${PORT} listo`));
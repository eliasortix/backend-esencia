-- 1. COMPETICIONES
CREATE TABLE IF NOT EXISTS competitions (
  id             SERIAL PRIMARY KEY,
  name           VARCHAR(255) UNIQUE NOT NULL,
  slug           VARCHAR(255),
  active         BOOLEAN DEFAULT true,
  created_at     TIMESTAMP DEFAULT NOW()
);

-- 2. EQUIPOS
CREATE TABLE IF NOT EXISTS teams (
  id             SERIAL PRIMARY KEY,
  competition_id INTEGER REFERENCES competitions(id) ON DELETE CASCADE,
  name           VARCHAR(255) NOT NULL,
  slug           VARCHAR(255),
  active         BOOLEAN DEFAULT true,
  created_at     TIMESTAMP DEFAULT NOW()
);

-- 3. TEMPORADAS (Ej: 2024/25)
CREATE TABLE IF NOT EXISTS seasons (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(100) UNIQUE NOT NULL,
  active      BOOLEAN DEFAULT true,
  created_at  TIMESTAMP DEFAULT NOW()
);

-- 4. TIPOS DE PRECIO
CREATE TABLE IF NOT EXISTS price_types (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(100) UNIQUE NOT NULL, -- Fan, Player, Retro
  price       NUMERIC(10,2) NOT NULL,
  created_at  TIMESTAMP DEFAULT NOW()
);

-- 5. PRODUCTOS (El Catálogo principal)
CREATE TABLE IF NOT EXISTS products (
  id                     SERIAL PRIMARY KEY,
  team_id                INTEGER REFERENCES teams(id) ON DELETE SET NULL,
  season_id              INTEGER REFERENCES seasons(id) ON DELETE SET NULL,
  price_type_id          INTEGER REFERENCES price_types(id) ON DELETE SET NULL,
  name                   VARCHAR(255) NOT NULL, -- Nombre comercial
  description            TEXT,
  main_image_url         TEXT, -- URL de Cloudinary para la foto de portada
  status                 VARCHAR(50) DEFAULT 'active',
  cost                   NUMERIC(10,2) DEFAULT 28.00,
  created_at             TIMESTAMP DEFAULT NOW(),
  updated_at             TIMESTAMP DEFAULT NOW()
);

-- 6. GALERÍA DE IMÁGENES (Fotos extra del mismo producto)
CREATE TABLE IF NOT EXISTS product_images (
  id          SERIAL PRIMARY KEY,
  product_id  INTEGER REFERENCES products(id) ON DELETE CASCADE,
  url         TEXT NOT NULL, -- URL de Cloudinary para fotos de detalle
  position    INTEGER DEFAULT 0,
  created_at  TIMESTAMP DEFAULT NOW()
);

-- 7. INVENTARIO (Stock real por tallas)
CREATE TABLE IF NOT EXISTS inventories (
  id                    SERIAL PRIMARY KEY,
  product_id            INTEGER REFERENCES products(id) ON DELETE CASCADE,
  size                  VARCHAR(20)   NOT NULL, -- S, M, L, XL...
  cost_price            NUMERIC(10,2) NOT NULL,
  is_sold               BOOLEAN       DEFAULT false,
  dorsal_name           VARCHAR(255),
  dorsal_number         VARCHAR(20),
  created_at            TIMESTAMP DEFAULT NOW()
);

-- 8. VENTAS (Historial)
CREATE TABLE IF NOT EXISTS sales (
  id                  SERIAL PRIMARY KEY,
  inventory_id        INTEGER REFERENCES inventories(id) ON DELETE SET NULL,
  product_id          INTEGER REFERENCES products(id)   ON DELETE SET NULL,
  sale_price          NUMERIC(10,2) NOT NULL,
  seller_name         VARCHAR(255),
  company_profit      NUMERIC(10,2),
  created_at          TIMESTAMP DEFAULT NOW()
);

-- ─── DATOS INICIALES PARA EMPEZAR YA ───
INSERT INTO price_types (name, price) VALUES 
('Fan', 28.00), ('Player', 30.00), ('Retro', 35.00) 
ON CONFLICT (name) DO NOTHING;

INSERT INTO seasons (name) VALUES 
('2024/25'), ('2023/24'), ('Retro Classics') 
ON CONFLICT (name) DO NOTHING;

INSERT INTO competitions (name, slug) VALUES 
('LaLiga', 'laliga'), ('Premier League', 'premier'), ('Champions League', 'ucl'), ('Selecciones', 'nacional') 
ON CONFLICT (name) DO NOTHING;
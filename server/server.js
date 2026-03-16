require("dotenv").config();

const cors = require("cors");
const express = require("express");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const sqlite3 = require("sqlite3").verbose();

const app = express();
const port = process.env.PORT || 3000;
const jwtSecret = process.env.JWT_SECRET || "troque-este-segredo";
const adminEmail = process.env.ADMIN_EMAIL || "admin@eficazz.com.br";
const adminPassword = process.env.ADMIN_PASSWORD || "eficazz2026@@";

const dbPath = process.env.SQLITE_PATH || path.join(__dirname, "blog.sqlite");
const db = new sqlite3.Database(dbPath);

const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        const name = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
        cb(null, name);
    }
});

const upload = multer({
    storage,
    fileFilter: (req, file, cb) => {
        const isImage = file.mimetype.startsWith("image/");
        cb(isImage ? null : new Error("Apenas imagens sao permitidas."), isImage);
    },
    limits: { fileSize: 5 * 1024 * 1024 }
});

app.use(cors({ origin: true }));
app.use(express.json({ limit: "2mb" }));
app.use("/uploads", express.static(uploadsDir));

db.serialize(() => {
    db.run(
        `CREATE TABLE IF NOT EXISTS posts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            slug TEXT NOT NULL UNIQUE,
            excerpt TEXT,
            content TEXT NOT NULL,
            category TEXT,
            image_url TEXT,
            published_at TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );`
    );
    db.run("CREATE INDEX IF NOT EXISTS posts_published_at_idx ON posts (published_at)");
});

function runQuery(query, params = []) {
    return new Promise((resolve, reject) => {
        db.run(query, params, function (error) {
            if (error) return reject(error);
            return resolve(this);
        });
    });
}

function getQuery(query, params = []) {
    return new Promise((resolve, reject) => {
        db.get(query, params, (error, row) => {
            if (error) return reject(error);
            return resolve(row);
        });
    });
}

function allQuery(query, params = []) {
    return new Promise((resolve, reject) => {
        db.all(query, params, (error, rows) => {
            if (error) return reject(error);
            return resolve(rows);
        });
    });
}

function slugify(value) {
    return value
        .toLowerCase()
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)+/g, "");
}

function mapDbError(error) {
    if (!error) return "Erro ao criar post.";
    if (error.code === "SQLITE_CONSTRAINT") return "Ja existe um post com esse titulo.";
    if (error.code === "SQLITE_BUSY") return "Banco SQLite ocupado. Tente novamente.";
    return "Erro ao criar post.";
}

function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.replace("Bearer ", "");

    if (!token) {
        return res.status(401).json({ error: "Token ausente." });
    }

    try {
        req.user = jwt.verify(token, jwtSecret);
        return next();
    } catch (error) {
        return res.status(401).json({ error: "Token invalido." });
    }
}

app.post("/api/login", (req, res) => {
    const { email, password } = req.body || {};

    if (email !== adminEmail || password !== adminPassword) {
        return res.status(401).json({ error: "Credenciais invalidas." });
    }

    const token = jwt.sign({ email }, jwtSecret, { expiresIn: "8h" });
    return res.json({ token });
});

app.get("/api/posts", async (req, res) => {
    try {
        const rows = await allQuery(
            "SELECT id, title, slug, excerpt, content, category, image_url, published_at FROM posts ORDER BY COALESCE(published_at, created_at) DESC"
        );
        return res.json(rows || []);
    } catch (error) {
        return res.status(500).json({ error: "Erro ao buscar posts." });
    }
});

app.get("/api/posts/:id", async (req, res) => {
    try {
        const row = await getQuery(
            "SELECT id, title, slug, excerpt, content, category, image_url, published_at FROM posts WHERE id = ?",
            [req.params.id]
        );
        if (!row) {
            return res.status(404).json({ error: "Post nao encontrado." });
        }
        return res.json(row);
    } catch (error) {
        return res.status(500).json({ error: "Erro ao buscar post." });
    }
});

app.post("/api/posts", authMiddleware, upload.single("image"), async (req, res) => {
    const { title, excerpt, content, category, published_at } = req.body || {};

    if (!title || !content) {
        return res.status(400).json({ error: "Titulo e conteudo sao obrigatorios." });
    }

    const slug = slugify(title);
    const imageUrl = req.file ? `/uploads/${req.file.filename}` : null;

    try {
        const result = await runQuery(
            "INSERT INTO posts (title, slug, excerpt, content, category, image_url, published_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [title, slug, excerpt || null, content, category || null, imageUrl, published_at || null]
        );
        return res.status(201).json({ id: result.lastID });
    } catch (error) {
        console.error("Erro ao criar post:", error);
        return res.status(500).json({ error: mapDbError(error) });
    }
});

app.put("/api/posts/:id", authMiddleware, upload.single("image"), async (req, res) => {
    const { title, excerpt, content, category, published_at } = req.body || {};

    if (!title || !content) {
        return res.status(400).json({ error: "Titulo e conteudo sao obrigatorios." });
    }

    const slug = slugify(title);
    const imageUrl = req.file ? `/uploads/${req.file.filename}` : null;

    try {
        const row = await getQuery("SELECT image_url FROM posts WHERE id = ?", [req.params.id]);

        if (!row) {
            return res.status(404).json({ error: "Post nao encontrado." });
        }

        const updatedImage = imageUrl || row.image_url;

        await runQuery(
            "UPDATE posts SET title = ?, slug = ?, excerpt = ?, content = ?, category = ?, image_url = ?, published_at = ?, updated_at = datetime('now') WHERE id = ?",
            [title, slug, excerpt || null, content, category || null, updatedImage, published_at || null, req.params.id]
        );

        return res.json({ ok: true });
    } catch (error) {
        return res.status(500).json({ error: "Erro ao atualizar post." });
    }
});

app.delete("/api/posts/:id", authMiddleware, async (req, res) => {
    try {
        const result = await runQuery("DELETE FROM posts WHERE id = ?", [req.params.id]);
        if (!result.changes) {
            return res.status(404).json({ error: "Post nao encontrado." });
        }
        return res.json({ ok: true });
    } catch (error) {
        return res.status(500).json({ error: "Erro ao remover post." });
    }
});

const siteDir = path.join(__dirname, "..");
app.use(express.static(siteDir));

app.get("/", (req, res) => {
    res.sendFile(path.join(siteDir, "index.html"));
});

app.listen(port, () => {
    console.log(`Blog backend rodando em http://localhost:${port}`);
});

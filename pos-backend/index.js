require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const morgan = require('morgan');
const fs = require('fs').promises;
const multer = require('multer');

const { authenticateToken, authorizeAdminOrManager } = require('./middleware/auth');
const ActivationService = require('./services/activationService');

const app = express();
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

// Static file path resolution
let publicPath;
if (process.env.NODE_ENV === 'production') {
  // In production, try multiple possible paths
  const possiblePaths = [
    path.join(__dirname, 'public'),  // Same directory as backend
    path.join(process.resourcesPath, 'pos-backend', 'public'),  // Electron main process resources
    path.join(path.dirname(__dirname), 'pos-backend', 'public')  // Parent directory structure
  ];
  
  // Use the first path that exists
  for (const testPath of possiblePaths) {
    if (require('fs').existsSync(testPath)) {
      publicPath = testPath;
      break;
    }
  }
  
  // Fallback to backend directory if none found
  if (!publicPath) {
    publicPath = path.join(__dirname, 'public');
  }
} else {
  publicPath = path.join(__dirname, 'public');
}

console.log(`📁 Static files path: ${publicPath}`);
console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
console.log(`📂 Backend __dirname: ${__dirname}`);
console.log(`🔧 Process resourcesPath: ${process.resourcesPath || 'not available'}`);

// Verify the public directory exists
if (!require('fs').existsSync(publicPath)) {
  console.log(`⚠️ Creating public directory: ${publicPath}`);
  require('fs').mkdirSync(publicPath, { recursive: true });
}

app.use(express.static(publicPath));

// Pastikan direktori promo ada
const promoDir = path.join(publicPath, 'promo');
require('fs').mkdir(promoDir, { recursive: true }, (err) => {
  if (err && err.code !== 'EEXIST') console.error(err);
});


// Config
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'change_me_in_env';

// MySQL Pool
const pool = mysql.createPool({
  host     : process.env.DB_HOST || 'localhost',
  user     : process.env.DB_USER || 'root',
  password : process.env.DB_PASS || '1234',
  database : process.env.DB_NAME || 'pos_db',
  port     : process.env.DB_PORT || 3306,
  waitForConnections : true,
  connectionLimit    : 10,
  queueLimit         : 0
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", message: "Backend running 🚀" });
});

// Initialize Activation Service
const activationService = new ActivationService();

/* =========================================================
   ACTIVATION SYSTEM ROUTES
   ========================================================= */

// GET current activation status
app.get('/api/activation/status', async (req, res) => {
  try {
    const status = await activationService.getActivationStatus();
    res.json(status);
  } catch (error) {
    console.error('Error getting activation status:', error);
    res.status(500).json({ error: 'Failed to get activation status' });
  }
});

// POST increment transaction counter
app.post('/api/activation/increment-transaction', async (req, res) => {
  try {
    const result = await activationService.incrementTransaction();
    res.json(result);
  } catch (error) {
    if (error.message === 'TRIAL_LIMIT_REACHED') {
      res.status(403).json({ 
        error: 'TRIAL_LIMIT_REACHED', 
        message: 'Batas trial 99 transaksi tercapai. Aktivasi diperlukan untuk melanjutkan.',
        code: 'TRIAL_EXPIRED'
      });
    } else {
      console.error('Error incrementing transaction:', error);
      res.status(500).json({ error: 'Failed to increment transaction counter' });
    }
  }
});

// POST activate license with serial number
app.post('/api/activation/activate', async (req, res) => {
  try {
    const { serialNumber, computerInfo } = req.body;
    
    if (!serialNumber) {
      return res.status(400).json({ 
        error: 'MISSING_SERIAL_NUMBER',
        message: 'Serial Number diperlukan untuk aktivasi' 
      });
    }
    
    const result = await activationService.activateLicense(serialNumber, computerInfo);
    
    res.json({
      success: true,
      message: result.temporary ? 
        'Aktivasi sementara berhasil - akan diverifikasi saat online' :
        'Aktivasi berhasil! Aplikasi sekarang unlimited.',
      data: {
        serialNumber: result.serialNumber.replace(/(.{4})(.{4})(.{6})(.{4})/, '$1-$2-****-$4'), // Mask middle part
        hardwareId: result.hardwareId.substring(0, 8) + '...', // Mask hardware ID
        type: result.type,
        temporary: result.temporary,
        expires: result.expires
      }
    });
  } catch (error) {
    console.error('Activation error:', error);
    
    // Handle MAX_INSTALLATIONS_REACHED explicitly
    if (error.code === 'MAX_INSTALLATIONS_REACHED') {
      return res.status(409).json({
        success: false,
        error: 'MAX_INSTALLATIONS_REACHED',
        message: 'Maksimum instalasi tercapai (3/3).',
        installations: error.installations || []
      });
    }
    
    let errorResponse = {
      success: false,
      error: 'ACTIVATION_FAILED',
      message: 'Aktivasi gagal. Silakan periksa Serial Number dan coba lagi.'
    };
    
    // Handle specific errors
    if (error.message.includes('Invalid serial number format')) {
      errorResponse.error = 'INVALID_FORMAT';
      errorResponse.message = 'Format Serial Number tidak valid. Format: DMPOS-YYYY-XXXXXX-XXXX';
    } else if (error.message.includes('Invalid serial number checksum')) {
      errorResponse.error = 'INVALID_CHECKSUM';
      errorResponse.message = 'Serial Number tidak valid. Periksa kembali nomor yang dimasukkan.';
    } else if (error.message.includes('Serial number not valid')) {
      errorResponse.error = 'SN_NOT_FOUND';
      errorResponse.message = 'Serial Number tidak ditemukan dalam database.';
    }
    
    res.status(400).json(errorResponse);
  }
});

// POST reset trial (untuk testing - production bisa dihapus)
app.post('/api/activation/reset-trial', async (req, res) => {
  try {
    const result = await activationService.resetTrialCounter();
    res.json({
      success: true,
      message: 'Trial counter berhasil direset ke 0'
    });
  } catch (error) {
    console.error('Error resetting trial:', error);
    res.status(500).json({ error: 'Failed to reset trial counter' });
  }
});

// GET hardware fingerprint (untuk debugging)
app.get('/api/activation/hardware-id', async (req, res) => {
  try {
    const hardwareId = await activationService.generateHardwareFingerprint();
    res.json({
      hardwareId: hardwareId.substring(0, 12) + '...', // Mask for security
      message: 'Hardware ID generated successfully'
    });
  } catch (error) {
    console.error('Error generating hardware ID:', error);
    res.status(500).json({ error: 'Failed to generate hardware ID' });
  }
});

// GET validation queue status
app.get('/api/activation/queue-status', async (req, res) => {
  try {
    // Implementasi sederhana untuk menampilkan jumlah pending validations
    res.json({
      pendingValidations: 0,
      lastSync: new Date().toISOString(),
      online: false // Akan true jika Railway server terhubung
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get queue status' });
  }
});



// Start server
let server;
const startServer = async () => {
  try {
    await pool.getConnection();
    console.log('✅ MySQL pool connected');
  } catch (e) {
    console.error('⚠️ DB connection failed:', e.message);
    console.error('⚠️ Starting server without DB. Features requiring DB are limited.');
  }
  server = app.listen(PORT, () => console.log(`🚀 Backend ready → http://localhost:${PORT}`));
};

const gracefulShutdown = () => {
  console.log('SIGTERM signal received: closing HTTP server');
  if (server) {
    server.close(() => {
      console.log('HTTP server closed');
      pool.end(() => {
        console.log('Database pool closed');
        process.exit(0);
      });
    });
  } else {
    process.exit(0);
  }
};

// Listen for termination signals
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown); // Also handle Ctrl+C for manual testing

// Hanya start server langsung kalau dijalankan manual (node index.js)
if (require.main === module) {
  startServer();
}

module.exports = { startServer, pool, app };

/* =========================================================
   DATABASE & PROMO SETTINGS
   ========================================================= */

// Multer config for video upload
const promoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, promoDir); // promoDir sudah didefinisikan di atas
  },
  filename: (req, file, cb) => {
    // Hapus video lama jika ada, agar hanya ada satu video promosi
    require('fs').readdir(promoDir, (err, files) => {
      if (!err && files) {
        for (const f of files) {
          if (f.startsWith('promo-video')) {
            require('fs').unlink(path.join(promoDir, f), () => {});
          }
        }
      }
    });
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const extension = path.extname(file.originalname);
    cb(null, 'promo-video-' + uniqueSuffix + extension);
  }
});

const uploadPromoVideo = multer({
  storage: promoStorage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = /video\/mp4|video\/webm/;
    if (allowedTypes.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Hanya file video .mp4 atau .webm yang diizinkan'));
    }
  }
}).single('promoVideoFile'); // Nama field dari form di frontend

// Multer config for image upload
const promoImageStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, promoDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const extension = path.extname(file.originalname);
    cb(null, 'promo-image-' + uniqueSuffix + extension);
  }
});

const uploadPromoImages = multer({
  storage: promoImageStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB limit per image
  fileFilter: (req, file, cb) => {
    const allowedTypes = /image\/jpeg|image\/png|image\/gif/;
    if (allowedTypes.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Hanya file gambar .jpg, .png, atau .gif yang diizinkan'));
    }
  }
}).array('promoImageFiles', 10); // Nama field dari form di frontend, maksimal 10 gambar

// POST to upload promo video
app.post('/api/settings/promo-video', authenticateToken, authorizeAdminOrManager, (req, res) => {
  uploadPromoVideo(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ message: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ message: 'File video tidak ditemukan.' });
    }

    try {
      const videoPath = `/promo/${req.file.filename}`;
      // Simpan path ke database (misalnya di tabel settings)
      // Untuk sekarang, kita asumsikan ada tabel `settings` dengan `key` dan `value`
      await pool.query(
        'INSERT INTO settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = ?',
        ['promo_video_path', videoPath, videoPath]
      );

      res.json({ 
        message: 'Video promosi berhasil diunggah.', 
        path: videoPath 
      });
    } catch (dbError) {
      res.status(500).json({ message: `Gagal menyimpan path video ke database: ${dbError.message}` });
    }
  });
});

// POST to upload promo images
app.post('/api/settings/promo-images', authenticateToken, authorizeAdminOrManager, (req, res) => {
  uploadPromoImages(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ message: err.message });
    }
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ message: 'File gambar tidak ditemukan.' });
    }

    try {
      const imagePaths = req.files.map(file => `/promo/${file.filename}`);
      // Simpan path gambar ke database (misalnya di tabel settings)
      // Kita akan menyimpan sebagai JSON string
      await pool.query(
        'INSERT INTO settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = ?',
        ['promo_image_paths', JSON.stringify(imagePaths), JSON.stringify(imagePaths)]
      );

      res.json({ 
        message: 'Gambar promosi berhasil diunggah.', 
        paths: imagePaths 
      });
    } catch (dbError) {
      res.status(500).json({ message: `Gagal menyimpan path gambar ke database: ${dbError.message}` });
    }
  });
});

// GET promo video path
app.get('/api/settings/promo-video', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT value FROM settings WHERE `key` = ?', ['promo_video_path']);
    if (rows.length > 0) {
      res.json({ path: rows[0].value });
    } else {
      res.json({ path: null }); // Or a default video path if desired
    }
  } catch (e) {
    console.error('Error fetching promo video path:', e);
    res.status(500).json({ message: 'Gagal mengambil path video promosi.' });
  }
});

// GET promo image paths
app.get('/api/settings/promo-images', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT value FROM settings WHERE `key` = ?', ['promo_image_paths']);
    if (rows.length > 0 && rows[0].value) {
      res.json({ paths: JSON.parse(rows[0].value) });
    } else {
      res.json({ paths: [] }); // Return empty array if no images or value is null
    }
  } catch (e) {
    console.error('Error fetching promo image paths:', e);
    res.status(500).json({ message: 'Gagal mengambil path gambar promosi.' });
  }
});

// DELETE a promo image
app.delete('/api/settings/promo-images/:filename', authenticateToken, authorizeAdminOrManager, async (req, res) => {
  const { filename } = req.params;
  const imagePath = path.join(promoDir, filename);

  try {
    // 1. Delete file from filesystem
    await fs.unlink(imagePath);

    // 2. Update database: remove path from promo_image_paths
    const [rows] = await pool.query('SELECT value FROM settings WHERE `key` = ?', ['promo_image_paths']);
    let currentImagePaths = [];
    if (rows.length > 0 && rows[0].value) {
      currentImagePaths = JSON.parse(rows[0].value);
    }

    const updatedImagePaths = currentImagePaths.filter(p => !p.includes(filename));

    await pool.query(
      'INSERT INTO settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = ?',
      ['promo_image_paths', JSON.stringify(updatedImagePaths), JSON.stringify(updatedImagePaths)]
    );

    res.json({ message: 'Gambar promosi berhasil dihapus.', paths: updatedImagePaths });

  } catch (e) {
    if (e.code === 'ENOENT') {
      return res.status(404).json({ message: 'File gambar tidak ditemukan.' });
    }
    console.error('Error deleting promo image:', e);
    res.status(500).json({ message: `Gagal menghapus gambar promosi: ${e.message}` });
  }
});


// GET current DB settings
app.get('/api/database/settings', authenticateToken, authorizeAdminOrManager, (req, res) => {
  try {
    res.json({
      dbHost: process.env.DB_HOST || '',
      dbPort: process.env.DB_PORT || 3306,
      dbName: process.env.DB_NAME || '',
      dbUsername: process.env.DB_USER || '',
      dbType: 'mysql', // Hardcoded for now
    });
  } catch (error) {
    res.status(500).json({ message: 'Gagal membaca pengaturan database.' });
  }
});

// POST to test DB connection
app.post('/api/database/test', authenticateToken, authorizeAdminOrManager, async (req, res) => {
  const { dbHost, dbPort, dbUsername, dbPassword, dbName } = req.body;
  let tempPool;
  try {
    tempPool = mysql.createPool({
      host: dbHost,
      port: dbPort,
      user: dbUsername,
      password: dbPassword,
      database: dbName,
      connectionLimit: 1,
      connectTimeout: 5000, // 5 seconds
    });
    const connection = await tempPool.getConnection();
    connection.release();
    res.json({ message: 'Koneksi berhasil!' });
  } catch (error) {
    console.error('Error testing database connection:', error); // Add this line
    res.status(400).json({ message: `Koneksi gagal: ${error.code || error.message}` });
  } finally {
    if (tempPool) {
      await tempPool.end();
    }
  }
});

// POST to save DB settings to .env file
app.post('/api/database/save', authenticateToken, authorizeAdminOrManager, async (req, res) => {
    const { dbHost, dbPort, dbUsername, dbPassword, dbName } = req.body;
    const envPath = path.join(__dirname, '.env');

    try {
        let envContent = await fs.readFile(envPath, 'utf8');
        const newSettings = {
            DB_HOST: dbHost,
            DB_PORT: dbPort,
            DB_USER: dbUsername,
            DB_PASS: dbPassword,
            DB_NAME: dbName,
        };

        for (const [key, value] of Object.entries(newSettings)) {
            const regex = new RegExp(`^${key}=.*`, 'm');
            if (value !== undefined) { // Only update if value is provided
                const newValue = `${key}=${value}`;
                if (regex.test(envContent)) {
                    envContent = envContent.replace(regex, newValue);
                } else {
                    envContent += `\n${newValue}`;
                }
            }
        }

        await fs.writeFile(envPath, envContent, 'utf8');
        res.json({ message: 'Pengaturan berhasil disimpan. Silakan restart aplikasi untuk menerapkan perubahan.' });

    } catch (error) {
        res.status(500).json({ message: `Gagal menyimpan file .env: ${error.message}` });
    }
});

/* =========================================================
   AUTH ENDPOINTS
   ========================================================= */

// LOGIN
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ message: 'Username & password wajib' });

  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE username = ?', [username]);
    if (!rows.length) return res.status(401).json({ message: 'Username / password salah' });

    const user = rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ message: 'Username / password salah' });

    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '8h' });
    res.json({ token, user: { id: user.id, username: user.username, role: user.role } });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});


// REGISTER (admin only)
app.post('/api/register', authenticateToken, authorizeAdminOrManager, async (req, res) => {

  const { username, password, role = 'kasir' } = req.body;
  if (!username || !password) return res.status(400).json({ message: 'Username & password wajib' });

  try {
    const hash = await bcrypt.hash(password, 10);
    const [result] = await pool.query(
      'INSERT INTO users (username, password, role) VALUES (?,?,?)',
      [username, hash, role]
    );
    res.status(201).json({ id: result.insertId, username, role });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'Username sudah ada' });
    res.status(500).json({ message: e.message });
  }
});

/* =========================================================
   PURCHASE RETURNS
   ========================================================= */

// GET all purchase returns
app.get('/api/purchase-returns', authenticateToken, authorizeAdminOrManager, async (req, res) => {
  try {
    const query = `
      SELECT pr.*, u.username as user_name
      FROM purchase_returns pr
      LEFT JOIN users u ON pr.user_id = u.id
      ORDER BY pr.return_date DESC
    `;
    const [rows] = await pool.query(query);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// GET a single purchase return by ID
app.get('/api/purchase-returns/:id', authenticateToken, authorizeAdminOrManager, async (req, res) => {
  try {
    const { id } = req.params;

    // Get the main return data
    const [returns] = await pool.query('SELECT * FROM purchase_returns WHERE id = ?', [id]);
    if (!returns.length) {
      return res.status(404).json({ message: 'Retur pembelian tidak ditemukan' });
    }
    const returnData = returns[0];

    // Get the items
    const [items] = await pool.query('SELECT * FROM purchase_return_items WHERE return_id = ?', [id]);

    res.json({ ...returnData, items });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// POST a new purchase return
app.post('/api/purchase-returns', authenticateToken, authorizeAdminOrManager, async (req, res) => {
  const {
    returnNumber,
    returnDate,
    invoiceNumber,
    invoiceDate,
    supplierName,
    supplierCode,
    supplierContact,
    items,
    subtotal,
    discount,
    tax,
    totalReturn,
    returnMethod,
    refundRef,
    approvedBy,
    supplierRep,
    notes,
    status,
    shippingInfo
  } = req.body;

  if (!returnNumber || !returnDate || !invoiceNumber || !supplierName || !Array.isArray(items) || !items.length) {
    return res.status(400).json({ message: 'Data retur pembelian tidak lengkap' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Insert the main return record
    const [returnResult] = await pool.query(
      `INSERT INTO purchase_returns (
        return_number, return_date, invoice_number, invoice_date, 
        supplier_name, supplier_code, supplier_contact, subtotal, 
        discount, tax, total_return, return_method, refund_reference, 
        approved_by, supplier_representative, notes, status, shipping_info, user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        returnNumber,
        returnDate,
        invoiceNumber,
        invoiceDate,
        supplierName,
        supplierCode,
        supplierContact,
        subtotal,
        discount || 0,
        tax || 0,
        totalReturn,
        returnMethod || 'refund',
        refundRef,
        approvedBy,
        supplierRep,
        notes,
        status || 'processed',
        shippingInfo,
        req.user.id
      ]
    );
    const returnId = returnResult.insertId;

    // Insert items and update product stock (if needed)
    for (const item of items) {
      await pool.query(
        `INSERT INTO purchase_return_items (
          return_id, product_code, product_name, quantity, unit, price, reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          returnId,
          item.productCode,
          item.productName,
          item.quantity,
          item.unit || 'pcs',
          item.price,
          item.reason
        ]
      );

      // If return method is 'replace', we might want to update product stock
      // This depends on your business logic
      // if (returnMethod === 'replace') {
      //   await pool.query(
      //     'UPDATE products SET stock = stock + ? WHERE id = ?',
      //     [item.quantity, item.productId]
      //   );
      // }
    }

    await conn.commit();
    res.status(201).json({ 
      success: true, 
      returnId,
      message: 'Retur pembelian berhasil disimpan' 
    });

  } catch (e) {
    await conn.rollback();
    if (e.code === 'ER_DUP_ENTRY') {
      res.status(409).json({ message: 'Nomor retur sudah digunakan' });
    } else {
      res.status(500).json({ message: e.message });
    }
  } finally {
    conn.release();
  }
});

// UPDATE purchase return status
app.put('/api/purchase-returns/:id/status', authenticateToken, authorizeAdminOrManager, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!status) {
    return res.status(400).json({ message: 'Status wajib diisi' });
  }

  try {
    const [result] = await pool.query(
      'UPDATE purchase_returns SET status = ? WHERE id = ?',
      [status, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Retur pembelian tidak ditemukan' });
    }

    res.json({ message: 'Status retur pembelian berhasil diperbarui' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

/* =========================================================
   PRODUCTS
   ========================================================= */

// GET low stock products
app.get('/api/products/low-stock', authenticateToken, authorizeAdminOrManager, async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, name, stock FROM products WHERE stock < 10 AND stock > 0 ORDER BY stock ASC');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// GET all
app.get('/api/products', async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM products');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// GET QUICK PRODUCTS
app.get('/api/quick-products', async (_req, res) => {
  try {
    // IDs for: Fotocopy A4 HP, Print A4 HP, Scan A4, Jilid Spiral, Laminating A4
    const quickProductIds = [74, 80, 88, 114, 97];
    const [rows] = await pool.query(
      'SELECT id, name, price, stock FROM products WHERE id IN (?)',
      [quickProductIds]
    );

    // Add color for UI styling and ensure order
    const colorMap = {
      74: 'red',    // Fotocopy
      80: 'green',  // Print
      88: 'yellow', // Scan
      114: 'red',    // Jilid/Press
      97: 'green',  // Laminating
    };

    const orderedRows = quickProductIds.map(id => {
      const product = rows.find(row => row.id === id);
      if (product) {
        // Simplify the name for the button to match the old UI
        let displayName = product.name;
        if (id === 74) displayName = 'Fotocopy';
        if (id === 80) displayName = 'Print BW';
        if (id === 88) displayName = 'Scan';
        if (id === 114) displayName = 'Press';
        if (id === 97) displayName = 'Laminating';
        return { ...product, name: displayName, color: colorMap[id] };
      }
      return null;
    }).filter(Boolean); // Filter out nulls if a product isn't found

    res.json(orderedRows);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// POST
app.post('/api/products', authenticateToken, authorizeAdminOrManager, async (req, res) => {
  const { name, price, type, jenis, ukuran, keyword, stock, harga_beli, barcode } = req.body;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await pool.query(
      'INSERT INTO products (name, price, type, jenis, ukuran, keyword, stock, harga_beli, barcode) VALUES (?,?,?,?,?,?,?,?,?)',
      [name, price, type, jenis, ukuran, keyword, stock || 0, harga_beli || 0, barcode || null]
    );
    const newId = result.insertId;

    // If barcode is not provided, generate one based on ID
    if (!barcode) {
      const generatedBarcode = `DMBRG${String(newId).padStart(6, '0')}`;
      await pool.query('UPDATE products SET barcode = ? WHERE id = ?', [generatedBarcode, newId]);
    }

    await conn.commit();
    res.status(201).json({ id: newId, ...req.body });
  } catch (e) {
    await conn.rollback();
    if (e.code === 'ER_DUP_ENTRY' && e.message.includes('barcode')) {
      return res.status(409).json({ message: 'Barcode sudah digunakan.' });
    }
    res.status(500).json({ message: e.message });
  } finally {
    conn.release();
  }
});

// BULK INSERT products
app.post('/api/products/bulk', authenticateToken, authorizeAdminOrManager, async (req, res) => {
  const products = req.body;

  if (!Array.isArray(products) || products.length === 0) {
    return res.status(400).json({ message: 'Request body must be a non-empty array of products.' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    let insertedCount = 0;
    for (const product of products) {
      const { name, price, type, jenis, ukuran, keyword, stock, harga_beli, barcode } = product;
      
      // Basic validation for each product
      if (!name || !price) {
        // You might want to throw an error and rollback, or just skip the product
        console.warn('Skipping product due to missing name or price:', product);
        continue;
      }

      const [result] = await conn.query(
        'INSERT INTO products (name, price, type, jenis, ukuran, keyword, stock, harga_beli, barcode) VALUES (?,?,?,?,?,?,?,?,?)',
        [name, price, type || null, jenis || null, ukuran || null, keyword || null, stock || 0, harga_beli || 0, barcode || null]
      );
      const newId = result.insertId;

      if (!barcode) {
        const generatedBarcode = `DMBRG${String(newId).padStart(6, '0')}`;
        await conn.query('UPDATE products SET barcode = ? WHERE id = ?', [generatedBarcode, newId]);
      }
      insertedCount++;
    }

    await conn.commit();
    res.status(201).json({ message: `${insertedCount} products imported successfully.` });

  } catch (e) {
    await conn.rollback();
    if (e.code === 'ER_DUP_ENTRY' && e.message.includes('barcode')) {
      return res.status(409).json({ message: `Satu atau lebih barcode sudah ada di database. Proses dibatalkan. Barcode duplikat: ${e.message.split("'")[1]}` });
    }
    res.status(500).json({ message: e.message });
  } finally {
    conn.release();
  }
});

// GET by barcode
app.get('/api/products/barcode/:barcode', authenticateToken, async (req, res) => {
  try {
    const { barcode } = req.params;
    const [rows] = await pool.query('SELECT * FROM products WHERE barcode = ?', [barcode]);
    if (rows.length === 0) {
      return res.status(404).json({ message: 'Produk dengan barcode ini tidak ditemukan.' });
    }
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// GET a single product by ID
app.get('/api/products/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.query('SELECT * FROM products WHERE id = ?', [id]);
    if (rows.length === 0) {
      return res.status(404).json({ message: 'Produk tidak ditemukan.' });
    }
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// PUT
app.put('/api/products/:id', authenticateToken, authorizeAdminOrManager, async (req, res) => {
  const { id } = req.params;
  const { name, price, type, jenis, ukuran, keyword, stock, harga_beli, barcode } = req.body;
  try {
    const [result] = await pool.query(
      'UPDATE products SET name=?, price=?, type=?, jenis=?, ukuran=?, keyword=?, stock=?, harga_beli=?, barcode=? WHERE id=?',
      [name, price, type, jenis, ukuran, keyword, stock, harga_beli, barcode, id]
    );
    if (!result.affectedRows) return res.status(404).json({ message: 'Produk tidak ditemukan' });
    res.json({ message: 'Produk diperbarui' });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY' && e.message.includes('barcode')) {
      return res.status(409).json({ message: 'Barcode sudah digunakan.' });
    }
    res.status(500).json({ message: e.message });
  }
});

// DELETE
app.delete('/api/products/:id', authenticateToken, authorizeAdminOrManager, async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM products WHERE id=?', [req.params.id]);
    if (!result.affectedRows) return res.status(404).json({ message: 'Produk tidak ditemukan' });
    res.json({ message: 'Produk dihapus' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// GET STOCK CARD
app.get('/api/stock-card/:productId', authenticateToken, authorizeAdminOrManager, async (req, res) => {
  const { productId } = req.params;

  try {
    // Cek apakah produk ada
    const [productRows] = await pool.query('SELECT name, stock FROM products WHERE id = ?', [productId]);
    if (productRows.length === 0) {
      return res.status(404).json({ message: 'Produk tidak ditemukan' });
    }
    const product = productRows[0];

    // Query untuk menggabungkan semua pergerakan stok
    const query = `
      -- Penjualan (Stok Keluar)
      SELECT
        t.tanggal AS date,
        CONCAT('Penjualan (Trx ID: ', t.id, ')') AS description,
        NULL AS stock_in,
        ti.qty AS stock_out
      FROM transaction_items ti
      JOIN transactions t ON ti.transaction_id = t.id
      WHERE ti.product_id = ?

      UNION ALL

      -- Retur Penjualan (Stok Masuk)
      SELECT
        sr.return_date AS date,
        CONCAT('Retur Penjualan (Retur ID: ', sr.id, ')') AS description,
        sri.qty AS stock_in,
        NULL AS stock_out
      FROM sales_return_items sri
      JOIN sales_returns sr ON sri.return_id = sr.id
      WHERE sri.product_id = ?

      -- Placeholder untuk Penerimaan Barang & Stok Opname
      -- Perlu tabel history terpisah untuk implementasi penuh

      ORDER BY date DESC
    `;

    const [movements] = await pool.query(query, [productId, productId]);

    // Menghitung sisa stok berjalan
    let runningStock = product.stock;
    const history = movements.map(m => {
      const stock_in = m.stock_in || 0;
      const stock_out = m.stock_out || 0;
      const currentStock = runningStock;
      
      // Untuk menghitung stok sebelumnya, kita membalikkan logikanya
      // Jika barang masuk, stok sebelumnya lebih sedikit
      // Jika barang keluar, stok sebelumnya lebih banyak
      runningStock = runningStock - stock_in + stock_out;

      return {
        date: m.date,
        description: m.description,
        stock_in,
        stock_out,
        balance: currentStock
      };
    }).reverse(); // Dibalik agar urutan dari yang terlama ke terbaru

    res.json({
      productName: product.name,
      currentStock: product.stock,
      history: history
    });

  } catch (e) {
    console.error('Error fetching stock card:', e);
    res.status(500).json({ message: e.message });
  }
});

// STOCK RECEIVE
app.post('/api/stock/receive', authenticateToken, authorizeAdminOrManager, async (req, res) => {
  const { product_id, quantity, supplier, _notes } = req.body;

  if (!product_id || !quantity || !supplier) {
    return res.status(400).json({ message: 'Product ID, quantity, and supplier are required.' });
  }

  if (quantity <= 0) {
    return res.status(400).json({ message: 'Quantity must be positive.' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Update product stock
    const [productUpdateResult] = await pool.query(
      'UPDATE products SET stock = stock + ? WHERE id = ?',
      [quantity, product_id]
    );

    if (!productUpdateResult.affectedRows) {
      throw new Error('Product not found or stock not updated.');
    }

    await conn.commit();
    res.status(200).json({ message: 'Stock received successfully.' });

  } catch (e) {
    await conn.rollback();
    res.status(500).json({ message: e.message });
  } finally {
    conn.release();
  }
});


/* =========================================================
   LAPORAN (protected, admin only)
   ========================================================= */

const adminOnly = (req, res, next) => {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') {
    return res.status(403).json({ message: 'Hanya admin atau manajer yang dapat mengakses.' });
  }
  next();
};

// Laporan Laba Rugi
app.get('/api/reports/profit', authenticateToken, adminOnly, async (req, res) => {
  const mode = req.query.mode || 'daily';
  let _group, label;
  switch (mode) {
    case 'yearly':
      _group = 'YEAR(tanggal)'; label = 'YEAR(tanggal)'; break;
    case 'monthly':
      _group = 'YEAR(tanggal), MONTH(tanggal)';
      label = `CONCAT(YEAR(tanggal), '-', LPAD(MONTH(tanggal),2,'0'))`; break;
    default:
      _group = 'tanggal'; label = 'tanggal'; break;
  }

  try {
    const [rows] = await pool.query(`
      SELECT ${label} AS label,
             SUM(ti.qty * ti.price)          AS total_penjualan,
             SUM(ti.qty * ti.harga_beli)     AS total_hpp,
             SUM(ti.qty * (ti.price - ti.harga_beli)) AS laba_kotor
      FROM transactions t
      JOIN transaction_items ti ON t.id = ti.transaction_id
      GROUP BY label
      ORDER BY label DESC
      LIMIT 31
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// Produk Terlaris
app.get('/api/reports/best-selling', authenticateToken, adminOnly, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT p.name,
             SUM(ti.qty)        AS total_quantity_sold,
             SUM(ti.qty * ti.price) AS total_revenue
      FROM transaction_items ti
      JOIN products p ON ti.product_id = p.id
      GROUP BY p.id, p.name
      ORDER BY total_quantity_sold DESC
      LIMIT 10
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// Penjualan per Kasir
app.get('/api/reports/sales-by-cashier', authenticateToken, adminOnly, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT u.username  AS cashier_name,
             SUM(t.total) AS total_sales,
             COUNT(t.id)  AS total_transactions
      FROM transactions t
      JOIN users u ON t.user_id = u.id
      GROUP BY u.id, u.username
      ORDER BY total_sales DESC
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

/* =========================================================
   TRANSACTIONS
   ========================================================= */

// GET history + chart
// GET history + chart
app.get('/api/rekap', authenticateToken, async (req, res) => {
  const mode = req.query.mode || 'daily';
  const { role, id: currentUserId } = req.user;
  const filterCashierId = req.query.cashierId;

  let dateFilterClause;
  
  // Build date filter clauses for chart and history separately
  let chartGroupBy, chartLabel;
  switch (mode) {
    case 'yearly':
      chartGroupBy = 'YEAR(t.tanggal)';
      chartLabel = 'YEAR(t.tanggal)';
      dateFilterClause = `YEAR(CURDATE())`;
      break;
    case 'monthly':
      chartGroupBy = `CONCAT(YEAR(t.tanggal), '-', LPAD(MONTH(t.tanggal),2,'0'))`;
      chartLabel = chartGroupBy;
      dateFilterClause = `DATE_SUB(CURDATE(), INTERVAL 12 MONTH)`;
      break;
    default: // daily
      chartGroupBy = 't.tanggal';
      chartLabel = 't.tanggal';
      dateFilterClause = `DATE_SUB(CURDATE(), INTERVAL 30 DAY)`;
      break;
  }

  const datePredicate = (col) => {
      if (mode === 'yearly') return `YEAR(${col}) = ${dateFilterClause}`;
      return `${col} >= ${dateFilterClause}`;
  }

  let userFilterClause = '';
  const userParams = [];
  if (role === 'kasir') {
    userFilterClause = 'AND user_id = ?'; // Generic user_id column
    userParams.push(currentUserId);
  } else if (filterCashierId) {
    userFilterClause = 'AND user_id = ?';
    userParams.push(filterCashierId);
  }

  try {
    // 1. Fetch chart data (only based on positive transactions)
    const chartQuery = `
        SELECT ${chartLabel} AS label, SUM(t.total) AS total 
        FROM transactions t
        WHERE ${datePredicate('t.tanggal')} ${userFilterClause.replace('user_id', 't.user_id')}
        GROUP BY ${chartGroupBy} ORDER BY ${chartGroupBy} ASC LIMIT 31
    `;
    const [chartRows] = await pool.query(chartQuery, userParams);

    // 2. Fetch transactions
    const transactionQuery = `
        SELECT t.*, t.transaction_code, u.username as cashier_name, 'transaction' as record_type, 
               CONCAT(t.tanggal, ' ', t.jam) as datetime
        FROM transactions t
        LEFT JOIN users u ON t.user_id = u.id
        WHERE ${datePredicate('t.tanggal')} ${userFilterClause.replace('user_id', 't.user_id')}
    `;
    const [trxRows] = await pool.query(transactionQuery, userParams);

    // 3. Fetch sales returns
    const salesReturnQuery = `
        SELECT 
            sr.id, sr.return_date, sr.return_time, sr.total_amount, sr.transaction_id,
            u.username as cashier_name, 
            'sales_return' as record_type,
            CONCAT(sr.return_date, ' ', sr.return_time) as datetime
        FROM sales_returns sr
        LEFT JOIN users u ON sr.user_id = u.id
        WHERE ${datePredicate('sr.return_date')} ${userFilterClause.replace('user_id', 'sr.user_id')}
    `;
    const [returnRows] = await pool.query(salesReturnQuery, userParams);

    // 4. Fetch closed shifts
    const shiftQuery = `
        SELECT s.id, s.end_time as datetime, s.user_id, u.username as cashier_name, 'shift_close' as record_type
        FROM shifts s
        LEFT JOIN users u ON s.user_id = u.id
        WHERE s.status = 'closed' 
          AND ${datePredicate('DATE(s.end_time)')}
          ${userFilterClause.replace('user_id', 's.user_id')}
    `;
    const [shiftRows] = await pool.query(shiftQuery, userParams);

    // 5. Combine and sort all records
    const combinedData = [...trxRows, ...shiftRows, ...returnRows];
    combinedData.sort((a, b) => new Date(b.datetime) - new Date(a.datetime));
    
    const limitedData = combinedData.slice(0, 150);

    // 6. Fetch related data (items) for transactions and returns in the limited list
    const transactionIds = limitedData.filter(r => r.record_type === 'transaction').map(t => t.id);
    const returnIds = limitedData.filter(r => r.record_type === 'sales_return').map(t => t.id);
    
    const [transactionItems] = transactionIds.length > 0 
        ? await pool.query('SELECT * FROM transaction_items WHERE transaction_id IN (?)', [transactionIds])
        : [[]];

    const [returnItems] = returnIds.length > 0
        ? await pool.query('SELECT * FROM sales_return_items WHERE return_id IN (?)', [returnIds])
        : [[]];

    const customerIds = limitedData
        .filter(r => r.record_type === 'transaction' && r.customer_id_for_loyalty)
        .map(t => t.customer_id_for_loyalty);
        
    let customerMap = {};
    if (customerIds.length > 0) {
        const [customerRows] = await pool.query('SELECT * FROM customers WHERE id IN (?)', [customerIds]);
        customerRows.forEach(c => customerMap[c.id] = c);
    }

    const finalHistory = limitedData.map(record => {
        if (record.record_type === 'transaction') {
            const items = transactionItems.filter(i => i.transaction_id === record.id);
            const customer = record.customer_id_for_loyalty ? customerMap[record.customer_id_for_loyalty] : record.customer;
            return { ...record, items, customer };
        }
        if (record.record_type === 'sales_return') {
            const items = returnItems.filter(i => i.return_id === record.id);
            return { ...record, items };
        }
        // For shift_close
        return record;
    });

    res.json({ history: finalHistory, chart: chartRows });

  } catch (e) {
    console.error("Rekap Error:", e);
    res.status(500).json({ message: e.message });
  }
});

// GET a single transaction by ID for reprinting
app.get('/api/transactions/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    // Fetch the main transaction details, joining with users to get cashier name
    const transactionQuery = `
      SELECT t.*, t.transaction_code, u.username AS cashier_name
      FROM transactions t
      LEFT JOIN users u ON t.user_id = u.id
      WHERE t.id = ?
    `;
    const [transactions] = await pool.query(transactionQuery, [id]);
    if (!transactions.length) {
      return res.status(404).json({ message: 'Transaksi tidak ditemukan' });
    }
    const transaction = transactions[0];

    // Fetch associated items
    const [items] = await pool.query('SELECT * FROM transaction_items WHERE transaction_id = ?', [id]);
    
    // Fetch customer details and calculate historical loyalty points
    let customer = null;
    let totalPointsAfterTransaction = null;
    if (transaction.customer_id_for_loyalty) {
        const [customerRows] = await pool.query('SELECT * FROM customers WHERE id = ?', [transaction.customer_id_for_loyalty]);
        if (customerRows.length > 0) {
            customer = customerRows[0];

            // To get the points total as it was after this transaction, we have to reverse all subsequent transactions.
            const [subsequentTransactions] = await pool.query(
                'SELECT SUM(points_earned) as total_earned, SUM(points_redeemed) as total_redeemed FROM transactions WHERE customer_id_for_loyalty = ? AND id > ?',
                [transaction.customer_id_for_loyalty, id]
            );
            
            const subsequentPoints = subsequentTransactions[0];
            const earnedSince = subsequentPoints.total_earned || 0;
            const redeemedSince = subsequentPoints.total_redeemed || 0;

            // Calculate the points total at the time this transaction was completed
            totalPointsAfterTransaction = (customer.loyalty_points - earnedSince) + redeemedSince;
            
            // Add this historical value to the customer object for the frontend to use
            customer.loyalty_points_at_time_of_transaction = totalPointsAfterTransaction;
        }
    }

    // Add the calculated total points to the main transaction object for consistency with the live transaction response
    const transactionWithPoints = { ...transaction, updatedTotalPoints: totalPointsAfterTransaction };

    // Combine and send the response
    res.json({ ...transactionWithPoints, items, customer: customer || transaction.customer });

  } catch (e) {
    console.error("Get Transaction by ID Error:", e);
    res.status(500).json({ message: e.message });
  }
});

// POST new transaction
app.post('/api/transactions', authenticateToken, async (req, res) => {
  // Destructure all data needed for the receipt from the request body
  const {
    customer,
    items,
    total, // This is now the finalTotal
    subtotal,
    bayar,
    kembalian,
    applied_discount_value,
    points_discount,
    redeemed_points, // This is the number of points
    discount_code,
    customer_id, // This is the ID of the selected customer
    customer_type
  } = req.body;
  
  const userId = req.user.id;

  // Basic validation
  if (!customer || !Array.isArray(items) || !items.length || typeof total === 'undefined' || typeof bayar === 'undefined') {
    return res.status(400).json({ message: 'Data transaksi tidak lengkap. Customer, items, total, dan bayar wajib diisi.' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // 1. Get active shift
    const [activeShifts] = await pool.query('SELECT id FROM shifts WHERE user_id = ? AND status = ?', [userId, 'active']);
    if (activeShifts.length === 0) {
      throw new Error('Tidak ada shift aktif. Silakan mulai shift terlebih dahulu.');
    }
    const shiftId = activeShifts[0].id;

    // 2. Get discount ID if code is provided
    let discountId = null;
    if (discount_code) {
        const [discountRows] = await pool.query('SELECT id FROM discounts WHERE code = ?', [discount_code]);
        if (discountRows.length > 0) {
            discountId = discountRows[0].id;
        }
    }

    // Pre-calculate points earned
    let pointsEarned = 0;
    if (customer_id) {
        const baseAmountForPoints = total + (points_discount || 0);
        pointsEarned = Math.floor(baseAmountForPoints / 10000);
    }

    // 3. Insert the main transaction record
    const transactionSql = `
      INSERT INTO transactions (
        tanggal, jam, customer, total, user_id, shift_id, discount_id, 
        customer_type, customer_id_for_loyalty, subtotal, applied_discount_value, 
        points_redeemed, points_discount, points_earned, bayar, kembalian
      ) VALUES (CURDATE(), CURTIME(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const transactionValues = [
      customer,
      total, // Final total
      userId,
      shiftId,
      discountId,
      customer_type,
      customer_id, // customer_id_for_loyalty
      subtotal,
      applied_discount_value || 0,
      redeemed_points || 0,
      points_discount || 0,
      pointsEarned, // Save points earned
      bayar,
      kembalian
    ];

    const [tx] = await pool.query(transactionSql, transactionValues);
    const txId = tx.insertId;

    // 4. Generate and save custom transaction code
    const now = new Date();
    const datePart = now.toISOString().slice(0, 10).replace(/-/g, ''); // YYYYMMDD
    const timePart = now.toTimeString().slice(0, 8).replace(/:/g, '');   // HHMMSS
    const transactionCode = `TRX-${datePart}${timePart}-${txId}`;
    await pool.query('UPDATE transactions SET transaction_code = ? WHERE id = ?', [transactionCode, txId]);


    // 5. Insert transaction items and update stock
    for (const it of items) {
      const [p] = await pool.query('SELECT harga_beli FROM products WHERE id=?', [it.product_id]);
      const harga_beli = p.length > 0 ? p[0].harga_beli : 0;

      await pool.query(
        'INSERT INTO transaction_items (transaction_id, product_id, name, qty, price, harga_beli) VALUES (?,?,?,?,?,?)',
        [txId, it.product_id, it.name, it.qty, it.price, harga_beli]
      );
      await pool.query('UPDATE products SET stock = stock - ? WHERE id=?', [it.qty, it.product_id]);
    }
    
    // 6. Handle loyalty points UPDATE
    let updatedTotalPoints = null; // Default to null
    if (customer_id) {
        // Lock the customer row for update to prevent race conditions
        const [customerRows] = await conn.query('SELECT loyalty_points FROM customers WHERE id = ? FOR UPDATE', [customer_id]);
        
        if (customerRows.length > 0) {
            const currentPoints = customerRows[0].loyalty_points;
            const pointsToRedeem = redeemed_points || 0;
            
            // Calculate the final point total
            const finalPoints = currentPoints - pointsToRedeem + pointsEarned;

            // Update the customer's points in a single query
            await conn.query(
                'UPDATE customers SET loyalty_points = ? WHERE id = ?', 
                [finalPoints, customer_id]
            );
            
            // Set the value to be returned to the frontend
            updatedTotalPoints = finalPoints;
        }
    }

    await conn.commit();
    
    // Kirim kembali data poin ke frontend
    res.status(201).json({ 
      success: true, 
      transactionId: txId, // Keep this for potential internal use
      transactionCode: transactionCode, // Send the new code to frontend
      pointsEarned: pointsEarned,
      updatedTotalPoints: updatedTotalPoints 
    });

  } catch (e) {
    await conn.rollback();
    console.error("Transaction Error:", e);
    res.status(500).json({ message: e.message });
  } finally {
    conn.release();
  }
});


/* =========================================================
   SALES RETURNS
   ========================================================= */

// GET all sales returns
app.get('/api/returns', authenticateToken, async (req, res) => { // Removed authorizeAdminOrManager
  const { role, id: currentUserId } = req.user;
  let query = `
    SELECT sr.*, u.username as user_name, t.transaction_code
    FROM sales_returns sr
    LEFT JOIN users u ON sr.user_id = u.id
    LEFT JOIN transactions t ON sr.transaction_id = t.id
  `;
  const params = [];

  if (role === 'kasir') {
    query += ` WHERE sr.user_id = ?`;
    params.push(currentUserId);
  }

  query += ` ORDER BY sr.return_date DESC, sr.return_time DESC`;

  try {
    const [rows] = await pool.query(query, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// POST a new sales return
app.post('/api/returns', authenticateToken, async (req, res) => {
  const { transaction_id, items, notes } = req.body;
  if (!transaction_id || !Array.isArray(items) || !items.length) {
    return res.status(400).json({ message: 'Data retur tidak lengkap' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [transactions] = await pool.query('SELECT * FROM transactions WHERE id = ?', [transaction_id]);
    if (!transactions.length) {
      throw new Error('Transaksi asal tidak ditemukan');
    }
    const originalTransaction = transactions[0];

    const [originalItems] = await pool.query('SELECT * FROM transaction_items WHERE transaction_id = ?', [transaction_id]);
    if (!originalItems.length) {
      throw new Error('Item transaksi asal tidak ditemukan.');
    }

    // 2. Calculate discount ratio and total value of the return *before* any DB inserts
    const totalBeforeDiscount = originalItems.reduce((acc, item) => acc + (item.qty * item.price), 0);
    const discountRatio = totalBeforeDiscount > 0 ? originalTransaction.total / totalBeforeDiscount : 1;

    let totalReturnedValue = 0;
    for (const item of items) {
      const originalItem = originalItems.find(oi => oi.product_id === item.product_id);
      if (!originalItem) {
        throw new Error(`Produk ID ${item.product_id} tidak ditemukan di transaksi asal.`);
      }
      if (item.qty > originalItem.qty) {
        throw new Error(`Jumlah retur untuk produk ID ${item.product_id} (${item.qty}) melebihi jumlah pembelian (${originalItem.qty}).`);
      }
      totalReturnedValue += item.qty * originalItem.price * discountRatio;
    }

    // 3. Create the sales return record with the final total_amount
    const [returnResult] = await pool.query(
      'INSERT INTO sales_returns (transaction_id, user_id, notes, total_amount, return_date, return_time) VALUES (?, ?, ?, ?, CURDATE(), CURTIME())',
      [transaction_id, req.user.id, notes || null, totalReturnedValue]
    );
    const returnId = returnResult.insertId;

    // 4. Process each returned item for stock and logging
    for (const item of items) {
      const { product_id, qty } = item;
      const originalItem = originalItems.find(oi => oi.product_id === product_id);
      const { name, price, harga_beli } = originalItem;

      // Insert into sales_return_items
      await pool.query(
        'INSERT INTO sales_return_items (return_id, product_id, name, qty, price, harga_beli) VALUES (?, ?, ?, ?, ?, ?)',
        [returnId, product_id, name, qty, price, harga_beli]
      );

      // Update product stock
      await pool.query('UPDATE products SET stock = stock + ? WHERE id = ?', [qty, product_id]);
    }

    await conn.commit();
    res.status(201).json({ success: true, returnId: returnId, message: 'Retur berhasil dibuat' });

  } catch (e) {
    await conn.rollback();
    res.status(e.message.includes('tidak ditemukan') || e.message.includes('tidak valid') || e.message.includes('melebihi') ? 400 : 500).json({ message: e.message });
  } finally {
    conn.release();
  }
});

// STOCK ADJUSTMENT
app.post('/api/stock/adjustment', authenticateToken, authorizeAdminOrManager, async (req, res) => {
  // eslint-disable-next-line no-unused-vars
  const { product_id, new_stock_quantity, notes } = req.body;

  if (!product_id || typeof new_stock_quantity === 'undefined' || new_stock_quantity < 0) {
    return res.status(400).json({ message: 'Product ID and a valid new stock quantity are required.' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Update product stock to the new quantity
    const [productUpdateResult] = await pool.query(
      'UPDATE products SET stock = ? WHERE id = ?',
      [new_stock_quantity, product_id]
    );

    if (!productUpdateResult.affectedRows) {
      throw new Error('Product not found or stock not updated.');
    }

    // Optionally, log the adjustment in a stock_history table if you have one
    // await pool.query(
    //   'INSERT INTO stock_history (product_id, old_stock, new_stock, adjustment_type, notes, user_id, date, time) VALUES (?, ?, ?, ?, ?, ?, CURDATE(), CURTIME())',
    //   [product_id, old_stock_from_db, new_stock_quantity, 'adjustment', notes, req.user.id]
    // );

    await conn.commit();
    res.status(200).json({ message: 'Stock adjusted successfully.' });

  } catch (e) {
    await conn.rollback();
    res.status(500).json({ message: e.message });
  } finally {
    conn.release();
  }
});

/* =========================================================
   USERS (admin & manager)
   ========================================================= */



app.get('/api/users', authenticateToken, authorizeAdminOrManager, async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, username, role, created_at FROM users');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

app.put('/api/users/:id', authenticateToken, authorizeAdminOrManager, async (req, res) => {
  const { id } = req.params;
  const { username, role } = req.body;

  // Prevent changing own role or deleting own account
  if (+id === +req.user.id && role && role !== req.user.role) {
    return res.status(400).json({ message: 'Tidak bisa mengubah peran sendiri' });
  }

  try {
    const [result] = await pool.query(
      'UPDATE users SET username=?, role=? WHERE id=?',
      [username, role, id]
    );
    if (!result.affectedRows) return res.status(404).json({ message: 'Pengguna tidak ditemukan' });
    res.json({ message: 'Pengguna berhasil diperbarui' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

app.delete('/api/users/:id', authenticateToken, authorizeAdminOrManager, async (req, res) => {
  if (+req.params.id === +req.user.id) return res.status(400).json({ message: 'Tidak bisa hapus diri sendiri' });
  try {
    const [r] = await pool.query('DELETE FROM users WHERE id=?', [req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ message: 'User tidak ditemukan' });
    res.json({ message: 'User dihapus' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

/* =========================================================
   SUPPLIERS
   ========================================================= */

// GET all suppliers
app.get('/api/suppliers', authenticateToken, async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, name, email, phone, address FROM suppliers ORDER BY name ASC');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// POST new supplier
app.post('/api/suppliers', authenticateToken, authorizeAdminOrManager, async (req, res) => {
  const { name, email, phone, address } = req.body;
  if (!name) {
    return res.status(400).json({ message: 'Nama supplier wajib diisi' });
  }
  try {
    const [result] = await pool.query(
      'INSERT INTO suppliers (name, email, phone, address) VALUES (?, ?, ?, ?)',
      [name, email || null, phone || null, address || null]
    );
    res.status(201).json({ id: result.insertId, ...req.body });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// PUT update supplier
app.put('/api/suppliers/:id', authenticateToken, authorizeAdminOrManager, async (req, res) => {
  const { id } = req.params;
  const { name, email, phone, address } = req.body;
  if (!name) {
    return res.status(400).json({ message: 'Nama supplier wajib diisi' });
  }
  try {
    const [result] = await pool.query(
      'UPDATE suppliers SET name=?, email=?, phone=?, address=? WHERE id=?',
      [name, email || null, phone || null, address || null, id]
    );
    if (!result.affectedRows) return res.status(404).json({ message: 'Supplier tidak ditemukan' });
    res.json({ message: 'Supplier berhasil diperbarui' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// DELETE supplier
app.delete('/api/suppliers/:id', authenticateToken, authorizeAdminOrManager, async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM suppliers WHERE id=?', [req.params.id]);
    if (!result.affectedRows) return res.status(404).json({ message: 'Supplier tidak ditemukan' });
    res.json({ message: 'Supplier berhasil dihapus' });
  } catch (e) {
    // Handle potential foreign key constraint error if a supplier is linked to other data
    if (e.code === 'ER_ROW_IS_REFERENCED_2') {
        return res.status(400).json({ message: 'Supplier tidak dapat dihapus karena sudah terhubung dengan data lain (misal: retur pembelian).' });
    }
    res.status(500).json({ message: e.message });
  }
});

/* =========================================================
   CUSTOMERS
   ========================================================= */

// GET all customers
app.get('/api/customers', authenticateToken, async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT id, name, email, phone, address, customer_type, loyalty_points, customer_uuid FROM customers');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// GET customers by search query
app.get('/api/customers/search', async (req, res) => {
  const { q } = req.query;
  if (!q) {
    return res.status(400).json({ message: 'Query parameter "q" is required.' });
  }
  try {
    const searchTerm = `%${q}%`;
    const [rows] = await pool.query(
      'SELECT id, name, email, phone, address, customer_type, loyalty_points, customer_uuid FROM customers WHERE name LIKE ? OR customer_uuid LIKE ?',
      [searchTerm, searchTerm]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// POST new customer
app.post('/api/customers', authenticateToken, authorizeAdminOrManager, async (req, res) => {
  const { name, email, phone, address, customer_type } = req.body;
  if (!name) {
    return res.status(400).json({ message: 'Nama pelanggan wajib diisi' });
  }
  try {
    const customer_uuid = crypto.randomUUID(); // Generate UUID
    const [result] = await pool.query(
      'INSERT INTO customers (name, email, phone, address, customer_type, customer_uuid) VALUES (?, ?, ?, ?, ?, ?)', // Add customer_uuid
      [name, email || null, phone || null, address || null, customer_type || 'Umum', customer_uuid] // Add customer_uuid
    );
    res.status(201).json({ id: result.insertId, customer_uuid, ...req.body }); // Return customer_uuid
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// PUT update customer
app.put('/api/customers/:id', authenticateToken, authorizeAdminOrManager, async (req, res) => {
  const { id } = req.params;
  const { name, email, phone, address, customer_type } = req.body;
  if (!name) {
    return res.status(400).json({ message: 'Nama pelanggan wajib diisi' });
  }
  try {
    const [result] = await pool.query(
      'UPDATE customers SET name=?, email=?, phone=?, address=?, customer_type=? WHERE id=?',
      [name, email || null, phone || null, address || null, customer_type || 'Umum', id]
    );
    if (!result.affectedRows) return res.status(404).json({ message: 'Pelanggan tidak ditemukan' });
    res.json({ message: 'Pelanggan berhasil diperbarui' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// DELETE customer
app.delete('/api/customers/:id', authenticateToken, authorizeAdminOrManager, async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM customers WHERE id=?', [req.params.id]);
    if (!result.affectedRows) return res.status(404).json({ message: 'Pelanggan tidak ditemukan' });
    res.json({ message: 'Pelanggan berhasil dihapus' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

/* =========================================================
   SHIFT MANAGEMENT
   ========================================================= */

// Get current shift status for the logged-in user
app.get('/api/shifts/status', authenticateToken, async (req, res) => {
  try {
    const [shifts] = await pool.query(
      'SELECT * FROM shifts WHERE user_id = ? AND status = ?',
      [req.user.id, 'active']
    );

    if (shifts.length > 0) {
      const shift = shifts[0];

      // Get total sales for the active shift
      const [salesResult] = await pool.query('SELECT SUM(total) as total_sales FROM transactions WHERE shift_id = ?', [shift.id]);
      const total_sales = salesResult[0].total_sales || 0;

      // Get total expenses for the active shift
      const [expensesResult] = await pool.query('SELECT SUM(amount) as total_expenses FROM operational_expenses WHERE shift_id = ?', [shift.id]);
      const total_expenses = expensesResult[0].total_expenses || 0;

      // Get total sales returns for the active shift
      const [returnsResult] = await pool.query(
        `SELECT SUM(sr.total_amount) as total_returns 
         FROM sales_returns sr
         JOIN transactions t ON sr.transaction_id = t.id
         WHERE t.shift_id = ?`,
        [shift.id]
      );
      const total_returns = returnsResult[0].total_returns || 0;


      // Combine all data into the shift object
      const shiftWithDetails = {
        ...shift,
        total_sales,
        total_expenses,
        total_returns
      };
      
      res.json({ isActive: true, shift: shiftWithDetails });

    } else {
      res.json({ isActive: false, shift: null });
    }
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// Start a new shift
app.post('/api/shifts/start', authenticateToken, async (req, res) => {
  const { opening_cash } = req.body;
  if (typeof opening_cash === 'undefined' || opening_cash < 0) {
    return res.status(400).json({ message: 'Kas awal wajib diisi dan harus angka positif.' });
  }

  try {
    // Check if there's already an active shift for this user
    const [existing] = await pool.query('SELECT id FROM shifts WHERE user_id = ? AND status = ?', [req.user.id, 'active']);
    if (existing.length > 0) {
      return res.status(409).json({ message: 'Anda sudah memiliki shift yang aktif.' });
    }

    const [result] = await pool.query(
      'INSERT INTO shifts (user_id, start_time, opening_cash, status) VALUES (?, NOW(), ?, ?)',
      [req.user.id, opening_cash, 'active']
    );
    res.status(201).json({ success: true, shiftId: result.insertId, message: 'Shift berhasil dimulai.' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// End a shift
app.post('/api/shifts/end', authenticateToken, async (req, res) => {
  const { closing_cash_physical } = req.body;
  if (typeof closing_cash_physical === 'undefined' || closing_cash_physical < 0) {
    return res.status(400).json({ message: 'Kas akhir fisik wajib diisi.' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [activeShifts] = await pool.query('SELECT id, opening_cash FROM shifts WHERE user_id = ? AND status = ?', [req.user.id, 'active']);
    if (activeShifts.length === 0) {
      throw new Error('Tidak ada shift aktif untuk ditutup.');
    }
    const shift = activeShifts[0];

    const [salesResult] = await pool.query('SELECT SUM(total) as total_sales FROM transactions WHERE shift_id = ?', [shift.id]);
    const total_sales = salesResult[0].total_sales || 0;

    // Menghitung total beban operasional untuk shift ini
    const [expensesResult] = await pool.query('SELECT SUM(amount) as total_expenses FROM operational_expenses WHERE shift_id = ?', [shift.id]);
    const total_expenses = expensesResult[0].total_expenses || 0;

    // Menghitung total retur penjualan untuk shift ini
    const [returnsResult] = await pool.query(
      `SELECT SUM(sr.total_amount) as total_returns 
       FROM sales_returns sr
       JOIN transactions t ON sr.transaction_id = t.id
       WHERE t.shift_id = ?`,
      [shift.id]
    );
    const total_returns = returnsResult[0].total_returns || 0;

    // Perhitungan kas sistem yang baru: (Kas Awal + Penjualan) - Beban - Retur
    const closing_cash_system = (parseFloat(shift.opening_cash) + parseFloat(total_sales)) - parseFloat(total_expenses) - parseFloat(total_returns);

    console.log('DEBUG: opening_cash:', shift.opening_cash);
    console.log('DEBUG: total_sales:', total_sales);
    console.log('DEBUG: total_expenses:', total_expenses);
    console.log('DEBUG: total_returns:', total_returns);
    console.log('DEBUG: calculated closing_cash_system:', closing_cash_system);

    await pool.query(
      'UPDATE shifts SET end_time = NOW(), closing_cash_physical = ?, closing_cash_system = ?, total_sales = ?, status = ? WHERE id = ?',
      [closing_cash_physical, closing_cash_system, total_sales, 'closed', shift.id]
    );

    await conn.commit();
    res.json({
      success: true,
      message: 'Shift berhasil ditutup.',
      summary: { ...shift, total_sales, total_expenses, total_returns, closing_cash_system, closing_cash_physical }
    });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ message: e.message });
  } finally {
    conn.release();
  }
});

/* =========================================================
   OPERATIONAL EXPENSES
   ========================================================= */

// GET all expenses (filtered by date range or active shift)
app.get('/api/expenses', authenticateToken, async (req, res) => {
  const { startDate, endDate, shift } = req.query;
  let query = `
    SELECT oe.*, u.username 
    FROM operational_expenses oe
    JOIN users u ON oe.user_id = u.id
  `;
  const params = [];

  if (shift === 'active') {
    const [activeShifts] = await pool.query('SELECT id FROM shifts WHERE user_id = ? AND status = ?', [req.user.id, 'active']);
    if (activeShifts.length === 0) {
      return res.json([]); // No active shift, return empty array
    }
    const shiftId = activeShifts[0].id;
    query += ' WHERE oe.shift_id = ?';
    params.push(shiftId);
  } else if (startDate && endDate) {
    query += ' WHERE oe.expense_date BETWEEN ? AND ?';
    params.push(startDate, endDate);
  }

  query += ' ORDER BY oe.expense_date DESC, oe.id DESC';

  try {
    const [rows] = await pool.query(query, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// POST a new expense
app.post('/api/expenses', authenticateToken, async (req, res) => {
  const { description, category, amount } = req.body;
  const userId = req.user.id;

  if (!description || !amount || amount <= 0) {
    return res.status(400).json({ message: 'Keterangan dan jumlah wajib diisi.' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [activeShifts] = await pool.query('SELECT id FROM shifts WHERE user_id = ? AND status = ?', [userId, 'active']);
    if (activeShifts.length === 0) {
      throw new Error('Tidak ada shift aktif. Tidak bisa mencatat beban.');
    }
    const shiftId = activeShifts[0].id;

    const [result] = await pool.query(
      'INSERT INTO operational_expenses (expense_date, description, category, amount, user_id, shift_id) VALUES (CURDATE(), ?, ?, ?, ?, ?)',
      [description, category || 'Lain-lain', amount, userId, shiftId]
    );

    await conn.commit();
    res.status(201).json({ success: true, id: result.insertId, message: 'Beban berhasil dicatat.' });
  } catch (e) {
    await conn.rollback();
    res.status(500).json({ message: e.message });
  } finally {
    conn.release();
  }
});

// DELETE an expense
app.delete('/api/expenses/:id', authenticateToken, authorizeAdminOrManager, async (req, res) => {
  const { id } = req.params;
  try {
    const [result] = await pool.query('DELETE FROM operational_expenses WHERE id = ?', [id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Data beban tidak ditemukan.' });
    }
    res.json({ success: true, message: 'Data beban berhasil dihapus.' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

/* =========================================================
   UNIFIED REPORTING
   ========================================================= */

app.post('/api/reports/print', authenticateToken, authorizeAdminOrManager, async (req, res) => {
    const { reports, startDate, endDate } = req.body;
    if (!reports || !Array.isArray(reports) || reports.length === 0 || !startDate || !endDate) {
        return res.status(400).json({ message: 'Jenis laporan, tanggal mulai, dan tanggal akhir wajib diisi.' });
    }

    const results = {};
    const conn = await pool.getConnection();

    try {
        for (const reportType of reports) {
            switch (reportType) {
                case 'sales_summary': {
                    const [transactions] = await conn.query(
                        `SELECT t.*, u.username as cashier_name 
                         FROM transactions t 
                         JOIN users u ON t.user_id = u.id 
                         WHERE t.tanggal BETWEEN ? AND ? 
                         ORDER BY t.tanggal DESC, t.jam DESC`,
                        [startDate, endDate]
                    );
                    results.sales_summary = { title: 'Laporan Penjualan', data: transactions };
                    break;
                }

                case 'profit_loss': {
                    if (req.user.role !== 'admin') continue;
                    const [profitLoss] = await conn.query(`
                        SELECT 
                            tanggal AS label,
                            SUM(ti.qty * ti.price) AS total_penjualan,
                            SUM(ti.qty * ti.harga_beli) AS total_hpp,
                            SUM(ti.qty * (ti.price - ti.harga_beli)) AS laba_kotor
                        FROM transactions t
                        JOIN transaction_items ti ON t.id = ti.transaction_id
                        WHERE t.tanggal BETWEEN ? AND ?
                        GROUP BY tanggal
                        ORDER BY tanggal ASC
                    `, [startDate, endDate]);
                    results.profit_loss = { title: 'Laporan Laba Rugi', data: profitLoss };
                    break;
                }

                case 'sales_by_cashier': {
                    const [salesByCashier] = await conn.query(`
                        SELECT 
                            u.username AS cashier_name,
                            SUM(t.total) AS total_sales,
                            COUNT(t.id) AS total_transactions
                        FROM transactions t
                        JOIN users u ON t.user_id = u.id
                        WHERE t.tanggal BETWEEN ? AND ?
                        GROUP BY u.id, u.username
                        ORDER BY total_sales DESC
                    `, [startDate, endDate]);
                    results.sales_by_cashier = { title: 'Laporan Penjualan per Kasir', data: salesByCashier };
                    break;
                }

                case 'shift_report': {
                    const [shiftReports] = await conn.query(`
                        SELECT s.*, u.username FROM shifts s
                        JOIN users u ON s.user_id = u.id
                        WHERE s.status = 'closed' AND DATE(s.start_time) BETWEEN ? AND ?
                        ORDER BY s.start_time DESC
                    `, [startDate, endDate]);
                    results.shift_report = { title: 'Laporan Shift', data: shiftReports };
                    break;
                }
            }
        }
        res.json(results);
    } catch (e) {
        res.status(500).json({ message: e.message });
    } finally {
        conn.release();
    }
});

/* =========================================================
   DISCOUNTS
   ========================================================= */

// VALIDATE DISCOUNT
app.post('/api/discounts/validate', authenticateToken, async (req, res) => {
  const { code, customer_type } = req.body;
  if (!code) {
    return res.status(400).json({ message: 'Kode diskon diperlukan' });
  }

  try {
    const query = `
      SELECT * FROM discounts
      WHERE code = ?
        AND active = 1
        AND (start_date IS NULL OR start_date <= CURDATE())
        AND (end_date IS NULL OR end_date >= CURDATE())
    `;
    const [rows] = await pool.query(query, [code]);

    if (!rows.length) {
      return res.json({ valid: false, message: 'Kode diskon tidak valid atau sudah kedaluwarsa.' });
    }

    const discount = rows[0];

    // Check customer type
    if (discount.customer_type && discount.customer_type !== 'Semua' && discount.customer_type !== customer_type) {
      return res.json({ valid: false, message: `Diskon ini hanya berlaku untuk pelanggan tipe: ${discount.customer_type}.` });
    }

    res.json({ valid: true, discount });
  } catch (err) {
    console.error('Error validating discount:', err);
    res.status(500).json({ message: 'Gagal memvalidasi diskon.' });
  }
});

app.get('/api/discounts', authenticateToken, async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM discounts');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

app.post('/api/discounts', authenticateToken, authorizeAdminOrManager, async (req, res) => {
  const { code, type, value, start_date, end_date, active, customer_type } = req.body;
  try {
    const [r] = await pool.query(
      'INSERT INTO discounts (code, type, value, start_date, end_date, active, customer_type) VALUES (?,?,?,?,?,?,?)',
      [code, type, value, start_date || null, end_date || null, active ?? 1, customer_type || null]
    );
    res.status(201).json({ id: r.insertId, ...req.body });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'Kode sudah ada' });
    res.status(500).json({ message: e.message });
  }
});

app.put('/api/discounts/:id', authenticateToken, authorizeAdminOrManager, async (req, res) => {
  const { code, type, value, start_date, end_date, active, customer_type } = req.body;
  try {
    const [r] = await pool.query(
      'UPDATE discounts SET code=?, type=?, value=?, start_date=?, end_date=?, active=?, customer_type=? WHERE id=?',
      [code, type, value, start_date || null, end_date || null, active, customer_type || null, req.params.id]
    );
    if (!r.affectedRows) return res.status(404).json({ message: 'Diskon tidak ditemukan' });
    res.json({ message: 'Diskon diperbarui' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

app.delete('/api/discounts/:id', authenticateToken, authorizeAdminOrManager, async (req, res) => {
  try {
    const [r] = await pool.query('DELETE FROM discounts WHERE id=?', [req.params.id]);
    if (!r.affectedRows) return res.status(404).json({ message: 'Diskon tidak ditemukan' });
    res.json({ message: 'Diskon dihapus' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ message: 'Not Found' });
});

// Error handler
app.use((err, _req, res) => {
  console.error(err.stack);
  res.status(500).json({ message: 'Something broke!' });
});

// Ekspor app dan pool untuk digunakan oleh Electron
module.exports = { app, pool, startServer };

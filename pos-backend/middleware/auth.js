const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'change_me_in_env';

const authenticateToken = (req, res, next) => {
  const auth = req.headers['authorization'];
  const token = auth && auth.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Token tidak ditemukan' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ message: 'Token tidak valid' });
    req.user = user;
    next();
  });
};

const authorizeAdminOrManager = (req, res, next) => {
  console.log('Mengecek peran untuk akses: ', req.user.role); // Tambahan debug log
  if (req.user.role !== 'admin' && req.user.role !== 'manager') {
    return res.status(403).json({ message: 'Akses ditolak: Hanya untuk admin atau manajer.' });
  }
  next();
};

module.exports = { authenticateToken, authorizeAdminOrManager };
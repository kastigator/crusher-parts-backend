// middleware/adminOnly.js
module.exports = function adminOnly(req, res, next) {
  if (!req.user?.role || req.user.role.toLowerCase() !== 'admin') {
    return res.status(403).json({ message: 'Доступ только для администратора' });
  }

  next();
};

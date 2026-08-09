// middleware/adminOnly.js
module.exports = function adminOnly(req, res, next) {
  if (req.user?.is_super_admin !== true) {
    return res.status(403).json({ message: 'Доступ только для администратора' });
  }

  next();
};

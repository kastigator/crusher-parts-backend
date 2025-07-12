module.exports = function adminOnly(req, res, next) {
  console.log('🔐 adminOnly — req.user:', req.user)

  if (!req.user?.role || req.user.role.toLowerCase() !== 'admin') {
    return res.status(403).json({ message: 'Доступ только для администратора' });
  }

  next();
}

module.exports = function requireLogin(req, res, next) {
  if (!req.session || !req.session.access_token || !req.session.user_email) {
    return res.redirect('/login');
  }
  next();
};

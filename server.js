require('dotenv').config()
const express = require("express");
var bodyParser = require("body-parser");
const cors = require("cors");
const app = express();
const https = require('http');
const fs = require('fs');
const socketIO = require('socket.io');
const routes = require('./routes');
const monitoringRoutes = require('./routes/monitoring');
const VideoStream = require('./controller/Streaming');
const session = require('express-session');
const authRoutes = require('./routes/auth');
const requireLogin = require('./middleware/requireLogin');
const AAD_API_BASE = process.env.AAD_API_BASE;
let socketServer;

const tls = {
  key: fs.readFileSync('./cert/key.pem'), // path to localhost+2-key.pem
  cert: fs.readFileSync('./cert/cert.pem'), // path to localhost+2.pem
  requestCert: false,
  rejectUnauthorized: false,
}

const webServer = https.createServer(app)
webServer.on('error', (err) => {
  console.error('starting web server failed:', err.message);
});

socketServer = socketIO(webServer, {
  serveClient: false,
  log: false,
  cors: {
    origin: "*"
  }
});

VideoStream.initStreaming(socketServer)

app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));
app.use(cors('*'));
app.options("*", cors());
app.set('view engine', 'ejs');
app.set('views', __dirname + '/layout');
app.use(express.static('public'))
app.use(session({
  secret: process.env.SESSION_SECRET, // Lấy từ .env
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false } // Nếu dùng HTTPS thực tế thì để true
}));
app.use(routes);
app.use(authRoutes);
app.use(monitoringRoutes);
app.get('/', requireLogin, (req, res, next) => {
  res.render('index.ejs', {
    user: {
      name: req.session.user_email || 'User',
      email: req.session.user_email
    }
  });
})
app.get('/dashboard', requireLogin, (req, res, next) => {
  // res.render('dashboard.ejs');
  res.render('dashboard.ejs', {
    user: {
      name: req.session.user_email || 'User',
      email: req.session.user_email
    }
  });
})

// Protected logs dashboard route - chỉ cho phép user đã login
app.get('/logs-dashboard', requireLogin, (req, res, next) => {
  res.render('logs-dashboard.ejs', {
    user: {
      name: req.session.user_email || 'User',
      email: req.session.user_email
    }
  });
});

webServer.listen(process.env.PORT, () => {
  console.info(`STREAMING SERVICE START AT PORT ${process.env.PORT}`)
});
const Router = require('express').Router();
const schimController = require('../controller/Streaming');
const statsController = require('../controller/Dashboard');
const diagController = require('../controller/Diag');

Router.post('/api/stream/new-session', schimController.createNewSession)
Router.get('/api/stream/remove-all', schimController.removeAllSession)
Router.get('/api/stats/get-stats', statsController.getStats)
Router.get('/api/stats/remove-all', statsController.removeFile)
Router.get('/api/diag/info', diagController.getInfo) // tạm thời, để so sánh UAT vs PROD
module.exports = Router;

const Router = require('express').Router();
const schimController = require('../controller/Streaming');
const statsController = require('../controller/Dashboard');

Router.post('/api/stream/new-session', schimController.createNewSession)
Router.get('/api/stream/remove-all', schimController.removeAllSession)
Router.get('/api/stats/get-stats', statsController.getStats) 
Router.get('/api/stats/remove-all', statsController.removeFile)
module.exports = Router; 
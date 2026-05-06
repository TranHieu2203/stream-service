const asyncRedis = require("async-redis");

class RedisConnector {
	constructor(redis_db) {
		this.client = asyncRedis.createClient({host: process.env.REDIS_HOST, port: 6379, username: process.env.REDIS_USR, password: process.env.REDIS_PASS, db: process.env.REDIS_DB});
		this.client.on("error", function(error) {
			console.log("Connect Redis Error 2 ", error)
		});
		this.client.on("connect", function(error) {
		  	console.log("Connect Redis Success")
		});
		this.getClient = this.getClient.bind(this)
		this.close = this.close.bind(this)
		this.quit = this.quit.bind(this)
	}
	getClient(){
		return this.client;
	}
	close(){
		this.client.quit()
	}
	quit(){
		this.client.quit()
	}
}
module.exports = RedisConnector
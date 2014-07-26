var fs = require("fs");
var EchoController = require("./echoController").Controller;
var FaviconController = require("./faviconController").Controller;
var StaticController = require("./staticController").Controller;

var HomeController = function () {
};

HomeController.prototype.get = function (req, res, callback) {
	req.ctx().setModel({
		statusCode: 200,
		body: fs.createReadStream(__dirname + "/../www/index.html"),
		headers: {
			'Content-Type': 'text/html'
		}
	});
	return callback();
};

HomeController.prototype.childControllers = function () {
	return [{
		name: "echo",
		path: ["echo"],
		controllerObj: new EchoController()
	},{
		name: "favicon",
		path: ["favicon.ico"],
		controllerObj: new FaviconController()
	}, {
		name: "static",
		path: ["static", "*"],
		controllerObj: new StaticController(__dirname + "/../www", "/static")
	}];
};

exports.Controller = HomeController;

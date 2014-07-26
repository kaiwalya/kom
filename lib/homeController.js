var EchoController = require("./echoController").Controller;
var FaviconController = require("./faviconController").Controller;
var StaticController = require("./staticController").Controller;

var HomeController = function () {};

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
		path: ["*"],
		controllerObj: new StaticController(__dirname + "/../www", null, "index.html")
	}];
};

exports.Controller = HomeController;

var EchoController = require("./echoController").Controller;

var HomeController = function () {
};

HomeController.prototype.childControllers = function () {
	return [{
		name: "echo",
		path: ["echo"],
		controllerObj: new EchoController()
	}];
};

exports.Controller = HomeController;

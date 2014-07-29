var HomeController = function () {};

HomeController.prototype.childControllers = function () {
	return [{
		name: "echo",
		path: ["echo"],
		controllerObj: new (require("./echoController").Controller)()
	},{
		name: "app",
		path: ["app", "*"],
		controllerObj: new (require("./appController").Controller)()
	},{
		name: "favicon",
		path: ["favicon.ico"],
		controllerObj: new (require("./faviconController").Controller)()
	}, {
		name: "static",
		path: ["*"],
		controllerObj: new (require("./staticController").Controller)(__dirname + "/../www/_site", null, "index.html")
	}];
};

exports.Controller = HomeController;

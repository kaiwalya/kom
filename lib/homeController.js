var fs = require("fs");
var EchoController = require("./echoController").Controller;

var HomeController = function () {
};

HomeController.prototype.get = function (req, res, callback) {
	req.ctx().setModel({
		statusCode: 200,
		body: fs.createReadStream(__dirname + "/index.html"),
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
	}];
};

exports.Controller = HomeController;

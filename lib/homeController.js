var EchoController = require("./echoController").Controller;

var HomeController = function () {
};

HomeController.prototype.get = function (req, res, callback) {
	req.ctx().setModel({
		statusCode: 200,
		body: {
			_links: {
				"http://www.w3.org/ns/json-ld#context": {
					type: "application/ld+json",
					href: "http://schema.org"
				}
			},
			"@type": "Person",
			"name": "Kaiwalya Kher",
			"sameAs": "https://www.facebook.com/knkher",
			"url": "https://kaiwalya.com"
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

var express = require('express');
var util = require('util');
var url = require('url');
var query = require('querystring');
var YAML = require('yamljs');

var context = require('./lib/context');

var app = express();

app.use(context.initializer);


var discoverChildControllers = function (parentController) {
	var arrOut = [];
	
	var controllerObj = parentController.controllerObj;
	if (controllerObj && controllerObj.childControllers) {
		var arrChildControllers = controllerObj.childControllers();

		if (arrChildControllers && arrChildControllers.length) {
			arrChildControllers.forEach(function (controller) {
				arrOut.push({
					name: controller.name,
					path: parentController.path.concat(controller.path),
					controllerObj: controller.controllerObj
				});
			});
		}
	}
	return arrOut;
};

var discoverControllers = function (arrFirstControllers) {
	var arrIn = [];

	var addToInput = function (controller) {
		arrIn.push(controller);
	};

	arrFirstControllers.forEach(addToInput);

	var arrOut = [];
	while(arrIn.length) {
		var controller = arrIn.pop();
		arrOut.push(controller);
		var arrChildControllers = discoverChildControllers(controller);
		if (arrChildControllers && arrChildControllers.length) {
			arrChildControllers.forEach(addToInput);
		}
	}

	return arrOut;
};

var EchoController = function () {};

EchoController.prototype.get = function (req, res, callback) {
	var parsedUrl = url.parse(req.url); 
	if (parsedUrl.query) {
		parsedUrl.query = query.parse(parsedUrl.query);
	}
	req.ctx().model = {
		method: req.method,
		url: parsedUrl,
		headers: req.headers
	};
	return callback();
};

var HomeController = function () {
};

HomeController.prototype.childControllers = function () {
	return [{
		name: "echo",
		path: ["echo"],
		controllerObj: new EchoController()
	}];
};


var arrControllers = discoverControllers([{
	name: "home",
	path: [],
	controllerObj: new HomeController()
}]);

arrControllers.forEach(function (controller) {
	var path = "/" + controller.path.join("/");
	var route = app.route("/" + controller.path.join("/"));
	["post", "put", "head", "get"].forEach(function (verb) {
		var handler = controller.controllerObj[verb];
		if (handler) {
			console.log("Registering:", verb, path);
			route[verb](handler.bind(controller.controllerObj));
		}
	});
});

app.use(function (req, res, callback) {

	var toYaml = function (req, res, callback) {
		//console.log("Format YAML");
		req.ctx().output = YAML.stringify(req.ctx().model);
		return callback();
	};

	var toHtml = function (req, res, callback) {
		//console.log("Format HTML");
		req.ctx().output = "<!DOCTYPE html><html><body><pre>\n" + YAML.stringify(req.ctx().model) + "\n</pre></body></html>";
		return callback();
	};

	var toJson = function (req, res, callback) {
		//console.log("Format JSON");
		req.ctx().output = req.ctx().model;
		return callback();
	};

	var toPlain = function (req, res, callback) {
		//console.log("Format Plain");
		req.ctx().output = util.inspect(req.ctx().model);
		return callback();	
	};

	var toDefault = toYaml.bind(null, req, res, callback);

	return res.format({
		default: toDefault,
		"application/yaml": toYaml,
		"application/json": toJson,
		"text/plain": toPlain,
		"text/html": toHtml
	});
});

app.use(function (req, res, callback) {
	//console.log("Finalization function called");
	res.send(req.ctx().output);
	return callback();
});

app.use(context.finalizer);

var port = process.env.PORT || 8000;
console.log("listening:", port);
app.listen(port);


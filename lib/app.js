var util = require('util');
var YAML = require('yamljs');

var context = require('./context');
var errors = require('./errors');


var HomeController = require('./homeController').Controller;

var App = function (params) {
	this._router = params.router;
	this._logger = params.logger;
	this._context = new context.Context(this);
};

App.prototype.logger = function() {
	return this._logger;
};

App.prototype.childLogger = function (logger, metaData) {
	return logger.child(metaData);
};

App.prototype.setLogger = function (logger) {
	this._logger = logger;
};

App.prototype.serve = function(port, callback) {
	var This = this;
	var app = This._router;
	app.use(This._context.initializer);

		
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
				var routeInfo = {
					verb: verb,
					path: path
				};
				This.logger().info("registering route", routeInfo);
				route[verb]([handler.bind(controller.controllerObj), function (err, req, res, callback) {
					var ctx = req.ctx();
					var errorModel;
					if (err) {
						errorModel = errors.errorFromError(err);
					}
					else {
						errorModel = errors.errorFromCode(500, "Internal Error. Incomplete implementation.");
					}
					ctx.logger().warn("Error in handler chain, setting error", errorModel);
					ctx.setModel(errorModel);
					return callback();
				}]);
			}
		});
	});

	app.use(function (req, res, callback) {
		if (!req.ctx().getModel()) {
			var errorModel = errors.errorFromCode(404, "Route not found");
			req.ctx().logger().warn("Not matching route, setting error", errorModel);
			req.ctx().setModel(errorModel);
		}
		return callback();
	});

	app.use(function (req, res, callback) {
		var model = req.ctx().getModel();

		var toYaml = function (req, res, callback) {
			model.entity = YAML.stringify(model.entity);
			return callback();
		};

		var toHtml = function (req, res, callback) {
			model.entity = "<!DOCTYPE html><html><body><pre>\n" + YAML.stringify(model.entity) + "\n</pre></body></html>";
			return callback();
		};

		var toJson = function (req, res, callback) {
			return callback();
		};

		var toPlain = function (req, res, callback) {
			model.entity = util.inspect(model.entity);
			return callback();	
		};

		var toDefault = function () {
			toYaml(req, res, callback);
			model.headers['Content-Type'] = "application/yaml";
		};

		return res.format({
			default: toDefault,
			"application/yaml": toYaml,
			"application/json": toJson,
			"text/plain": toPlain,
			"text/html": toHtml
		});
	});

	app.use(function (req, res, callback) {
		var ctx = req.ctx();
		var model = ctx.getModel();
		if (model.headers) {
			Object.keys(model.headers).forEach(function (headerKey) {
				var headerValue = model.headers[headerKey];
				res.header(headerKey, headerValue);
			});
		}
		res.send(model.statusCode, model.entity);
		return callback();
	});

	app.use(This._context.finalizer);

	This.logger().info("listening:", port);
	app.listen(port, callback);
};

exports.App = App;
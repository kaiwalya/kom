var util = require('util');
var stream = require('stream');

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
	app.use(function (req, res, callback) {
		res.setHeader('Access-Control-Allow-Origin', "*");
		return callback();
	});

		
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
		if (model.headers && 'Content-Type' in model.headers) {
			return callback();
		}
		

		var jsonLinkToTagString = function (key, value) {
			return "<" + value.href + ">" + "; " + "rel=" + key + "; " + "type=" + value.type;
		};

		var moveLinksFromBodyToHeader = function () {
			if (model.body._links) {
				var links = model.headers['Link'];
				if (!links) {
					links = [];
				}
				else if (links && !(links instanceof Array)) {
					links = [links];
				}

				for (var key in model.body._links) {
					var value = model.body._links[key];
					var headerString = jsonLinkToTagString(key, value);
					links.push(headerString);
				}
				if (links.length) {
					model.headers['Link'] = links;	
				}
			}
		};

		var toYaml = function (req, res, callback) {
			model.body = YAML.stringify(model.body);
			return callback();
		};

		var toHtml = function (req, res, callback) {

			if (model.headers['Content-Type'] === 'text/html') {
				return callback();
			}
			
			var headScriptOpen = "<!DOCTYPE html><html><head>";
			var headScript = "";
			var headScriptClose = "</head>";

			var ldctxKey = "http://www.w3.org/ns/json-ld#context";
			if (model.body && model.body._links && model.body._links[ldctxKey]) {
				
				headScriptOpen = headScriptOpen + "<script type=\"application/ld+json\">";
				headScript = JSON.parse(JSON.stringify(model.body));
				delete headScript._links;

				headScript["@context"] = model.body._links[ldctxKey].href;
				model.body["@context"] = model.body._links[ldctxKey].href;
				headScript = JSON.stringify(headScript);
				headScriptClose = "</script>" + headScriptClose;
			}

			moveLinksFromBodyToHeader();
			delete model.body._links;

			var bodyPreOpen = "<body><pre>";
			var bodyContent = YAML.stringify(model.body);
			var bodyPreClose = "</pre></body></html>";

			model.body =  headScriptOpen + headScript + headScriptClose + bodyPreOpen + bodyContent + bodyPreClose;
			return callback();
		};

		var toJson = function (req, res, callback) {
			moveLinksFromBodyToHeader();
			return callback();
		};

		var toJsonLd = function (req, res, callback) {
			moveLinksFromBodyToHeader();
			delete model.body._links;

			return callback();
		};

		var toPlain = function (req, res, callback) {
			model.body = util.inspect(model.body);
			return callback();
		};

		var defaultFormat = "text/html";
		var formatMap = {
			"text/html": toHtml,
			"application/ld+json": toJsonLd,
			"application/json": toJson,
			"application/yaml": toYaml,
			"text/plain": toPlain
		};

		formatMap.default = function () {
			(formatMap[defaultFormat])(req, res, callback);
			model.headers['Content-Type'] = "application/yaml";
		};

		return res.format(formatMap);
	});

	app.use(function (req, res, callback) {
		var ctx = req.ctx();
		var model = ctx.getModel();
		if (model.body instanceof stream.Readable) {
			res.writeHead(model.statusCode, model.headers);
			model.body.pipe(res);
			res.on('close', function () {
				ctx.logger().warn('Pipe closed unexpectedly.');
				return callback();
			});
			res.on('finish', function () {
				return callback();
			});
		}
		else {
			if (model.headers) {
				Object.keys(model.headers).forEach(function (headerKey) {
					var headerValue = model.headers[headerKey];
					res.setHeader(headerKey, headerValue);
				});
			}
			res.send(model.statusCode, model.body);
			return callback();
		}
	});

	app.use(This._context.finalizer);

	This.logger().info("listening:", port);
	app.listen(port, callback);
};

exports.App = App;

var url = require('url');
var query = require('querystring');

var EchoController = function () {};

EchoController.prototype.get = function (req, res, callback) {
	var parsedUrl = url.parse(req.url); 
	if (parsedUrl.query) {
		parsedUrl.query = query.parse(parsedUrl.query);
	}
	req.ctx().setModel({
		statusCode: 200,
		entity: {
			method: req.method,
			url: parsedUrl,
			headers: req.headers
		}
	});
	return callback();
};

exports.Controller = EchoController;

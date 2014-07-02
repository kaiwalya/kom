var restify = require("restify");
var fs = require("fs");

var server = restify.createServer({name: "kaiwalya-web"});
server.use(function (req, res, callback) {
	var rootUrl = (req.isSecure() ? "https" : "http") + "://" + req.headers['host'];
	req.kontext = {
		rootUrl: rootUrl
	};
	return callback();
});

server.use(function (req, res, callback) {
	res.header('x-request-id', req.getId());
	res.header('x-rooturl', req.kontext.rootUrl);
	return callback();
});

var loadRoutes = function (server, callback) {
	server.get("/", function (req, res, callback) {
		if (req.accepts("html")) {
			var file = fs.createReadStream(__dirname + "/index.html");
			file.pipe(res);
			return callback();
		}
		res.send(200);
		return callback();
	});
	return callback();
};

loadRoutes(server, function (err) {
	if (err) {
		throw err;
	}
	server.listen(8000, '0.0.0.0');
});






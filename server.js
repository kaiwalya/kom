var express = require('express');


var app = express();

app.get("/echo", function (req, res, next) {
	var input = {
		method: req.method,
		url: req.url,
		headers: req.headers
	};
	res.send(input);
	return next();
}).listen(process.env.PORT || 8000);


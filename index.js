var http = require("http");
var async = require("async");
var Negotiator = require("negotiator");
var util = require("util");

var QLimit = 64;

var requestQ = async.queue(function (task, callback) {
	if (task.type === "init") {
		var id = task.id;
		var request = task.request;
		var response = task.response;

		var negotiator = new Negotiator(request);

		var acceptableMediaTypes = ['application/ld+json', 'application/json', 'text/html'];
		var mediaType = negotiator.mediaType(acceptableMediaTypes);
		var body;
		var statusCode;
		if (!mediaType) {
			statusCode = 406;
			body = new Error("The following types are acceptable: " + acceptableMediaTypes.join("; "));
		}
		else {
			
			if (request.url === "/robots.txt") {
				statusCode = 200;
				body = "User-agent: *\nAllow: /";
			}
			else if (request.url === "/") {
				statusCode = 200;
				body = "kaiwalya.com";
			}
			else {
				statusCode = 404;
				body = new Error("The requested route was not found");
			}
			
		}

		
		var headers = {
			"X-Request-ID": id,
			"Content-Type": mediaType
		};
		if (mediaType !== 'text/html') {
			if (body instanceof Error) {
				body = body.toString();
			}
			else if ((typeof body !== 'string') && !(body instanceof String)) {
				body = JSON.stringify(body);	
			}
			headers["Content-Length"] = body.length;
		}
		else {
			if (body instanceof Error) {
				body = body.toString();
			}
			else if ((typeof body !== 'string') && !(body instanceof String)) {
				body = JSON.stringify(body);	
			}
			body = "<!DOCTYPE html><html><body>" + body + "</body></html>";

			headers["Content-Length"] = body.length;
		}

		response.writeHead(statusCode, headers);
		response.write(body);
		response.end();		
		

		var responseTime = process.hrtime(task.creationTime.hrtime);
		task.statusCode = statusCode;
		task.responseTime = responseTime;

		task.type = "done";
		task.doneQ.push(task);
		return setImmediate(callback);

	}
	else if (task.type === "done") {

		var tMicroSeconds = task.responseTime[0] * 1e6 + task.responseTime[1] * 1e-3;
		tMicroSeconds = Math.round(tMicroSeconds);
		console.log(JSON.stringify({
			id: task.id,
			responseTime: tMicroSeconds + "μs",
			statusCode: task.statusCode
		}));
		return setImmediate(callback);
	}
	
}, QLimit);

http.createServer(function (request, response) {
	var task = {
		creationTime: {
			hrtime: process.hrtime(),
			date: (new Date()).getTime()
		},
		request: request,
		response: response,
		type: "init",
		doneQ: requestQ
	};

	var random = "" + Math.floor(Math.random() * 1e6);
	random = (new Array(7 - random.length)).join("0") + random;

	var ns = "" + task.creationTime.hrtime[1];
	ns = (new Array(10 - ns.length)).join("0") + ns;

	task.id = util.format("%d_%s_%s", task.creationTime.date, ns, random);
	
	console.log(JSON.stringify({
		id: task.id,
		route: request.method + " " + request.url,
		headers: task.request.headers
	}));

	requestQ.push(task);
}).listen(8000, "0.0.0.0");




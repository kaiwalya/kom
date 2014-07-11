var http = require('http');
var util = require('util');
var port = process.env.PORT || 1337;
http.createServer(function(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.write(req.method + " " + req.url + "\n");
  res.end(util.inspect(req.headers));
}).listen(port);

